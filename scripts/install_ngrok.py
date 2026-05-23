#!/usr/bin/env python3
"""Install ngrok authtoken and configure a fixed tunnel.

On macOS this stores the token in Keychain through the Swift helper.
On Linux/other hosts it reads OBS_NGROK_AUTHTOKEN or
~/.config/openclaw/ngrok-authtoken.
"""

import getpass
import os
import shutil
import subprocess
import sys
import stat
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
SWIFT_SOURCE = SCRIPT_DIR / 'ngrok_keychain.swift'
BINARY_DIR = Path.home() / 'Library' / 'Application Support' / 'OpenClaw' / 'observability'
BINARY_PATH = BINARY_DIR / 'ngrok_keychain'
NGROK_BIN = Path.home() / '.local' / 'bin' / 'ngrok'
ENV_FILE = SCRIPT_DIR.parent / '.env'
LINUX_TOKEN_FILE = Path.home() / '.config' / 'openclaw' / 'ngrok-authtoken'
DASHBOARD_PORT = 18902


def find_swiftc() -> str:
    swiftc = shutil.which('swiftc')
    if swiftc:
        return swiftc
    try:
        proc = subprocess.run(['xcrun', '--find', 'swiftc'],
                              capture_output=True, text=True, check=True)
        return proc.stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        raise RuntimeError('swiftc not available. Install Xcode Command Line Tools.')


def compile_keychain_helper(swiftc: str) -> Path:
    BINARY_DIR.mkdir(parents=True, exist_ok=True)
    cmd = [swiftc, '-O', str(SWIFT_SOURCE), '-o', str(BINARY_PATH)]
    print(f'Compiling keychain helper...')
    subprocess.run(cmd, check=True)
    os.chmod(BINARY_PATH, 0o700)
    return BINARY_PATH


def install_token(binary: Path) -> None:
    """Run the keychain binary in install mode — it reads token from stdin."""
    print()
    print('=' * 50)
    print('Please enter your ngrok authtoken.')
    print('Get it from: https://dashboard.ngrok.com/get-started/your-authtoken')
    print('(Input will be stored in macOS Keychain, never written to disk)')
    print('=' * 50)
    subprocess.run([str(binary), 'install'], check=True)


def get_token(binary: Path) -> str:
    result = subprocess.run([str(binary), 'get'], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError('Failed to read token from Keychain')
    return result.stdout.strip()


def configure_ngrok(token: str) -> None:
    print('\nConfiguring ngrok...')
    subprocess.run([str(NGROK_BIN), 'config', 'add-authtoken', token],
                   check=True, capture_output=True)
    print('ngrok authtoken configured.')


def get_linux_token() -> str:
    token = os.environ.get('OBS_NGROK_AUTHTOKEN', '').strip()
    if token:
        return token

    if LINUX_TOKEN_FILE.exists():
        mode = stat.S_IMODE(LINUX_TOKEN_FILE.stat().st_mode)
        if mode & 0o077:
            raise RuntimeError(f'{LINUX_TOKEN_FILE} must not be group/world readable; run chmod 600 {LINUX_TOKEN_FILE}')
        token = LINUX_TOKEN_FILE.read_text().strip()
        if token:
            return token

    print()
    print('=' * 50)
    print('Please enter your ngrok authtoken.')
    print('Get it from: https://dashboard.ngrok.com/get-started/your-authtoken')
    print(f'It will be saved to {LINUX_TOKEN_FILE} with mode 0600.')
    print('=' * 50)
    token = getpass.getpass('ngrok authtoken: ').strip()
    if not token:
        raise RuntimeError('No token provided')
    LINUX_TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    LINUX_TOKEN_FILE.write_text(token + '\n')
    os.chmod(LINUX_TOKEN_FILE, 0o600)
    return token


def get_or_create_domain() -> str:
    """Check if user has a free static domain, return it."""
    print('\nChecking ngrok domains...')
    result = subprocess.run([str(NGROK_BIN), 'api', 'reserved-domains', 'list'],
                            capture_output=True, text=True, timeout=15)
    if result.returncode == 0 and 'ngrok-free.app' in result.stdout:
        # Extract domain from output
        for line in result.stdout.split('\n'):
            if 'ngrok-free.app' in line:
                parts = line.split()
                for p in parts:
                    if 'ngrok-free.app' in p:
                        domain = p.strip()
                        print(f'Found existing domain: {domain}')
                        return domain

    # No domain found — tell user to claim one
    print('\nNo fixed domain found.')
    print('Go to https://dashboard.ngrok.com/domains')
    print('Click "New Domain" to claim your free static domain (e.g., xxx.ngrok-free.app)')
    print()
    domain = input('Enter your ngrok domain (e.g., your-name.ngrok-free.app): ').strip()
    if not domain:
        raise RuntimeError('No domain provided')
    return domain


def save_fixed_url(domain: str) -> None:
    url = f'https://{domain}'
    # Read existing .env
    existing = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                existing[k.strip()] = v.strip()

    existing['OBS_FIXED_URL'] = url
    existing['OBS_NGROK_DOMAIN'] = domain

    ENV_FILE.write_text('\n'.join(f'{k}={v}' for k, v in existing.items()) + '\n')
    print(f'\nSaved to {ENV_FILE}:')
    print(f'  OBS_FIXED_URL={url}')
    print(f'  OBS_NGROK_DOMAIN={domain}')


def test_connectivity(domain: str) -> None:
    """Start ngrok briefly and test."""
    import time

    print(f'\nTesting tunnel to http://127.0.0.1:{DASHBOARD_PORT}...')

    proc = subprocess.Popen(
        [str(NGROK_BIN), 'http', f'--domain={domain}', str(DASHBOARD_PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )

    try:
        time.sleep(5)

        # Test via ngrok API
        result = subprocess.run(
            ['curl', '-s', '--max-time', '10', f'https://{domain}/healthz'],
            capture_output=True, text=True
        )

        if '"ok":true' in result.stdout:
            print(f'✅ Tunnel works! https://{domain}/healthz returned OK')
        else:
            print(f'⚠️  Tunnel started but healthz not responding yet.')
            print(f'   This is normal if dashboard is still starting.')
            print(f'   URL: https://{domain}')
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def main() -> int:
    # Check ngrok binary
    if not NGROK_BIN.exists():
        print(f'ERROR: ngrok not found at {NGROK_BIN}')
        print('Install: curl -s https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-arm64.tgz | tar xz -C ~/.local/bin/')
        return 1

    if sys.platform == 'darwin':
        # Compile keychain helper
        swiftc = find_swiftc()
        binary = compile_keychain_helper(swiftc)

        # Install token to keychain
        install_token(binary)

        # Read back and configure ngrok
        token = get_token(binary)
    else:
        token = get_linux_token()

    configure_ngrok(token)

    # Get or create domain
    domain = get_or_create_domain()
    save_fixed_url(domain)

    # Test
    test_connectivity(domain)

    print()
    print('=' * 50)
    print('Setup complete!')
    print(f'Fixed URL: https://{domain}')
    print()
    print('Next steps:')
    print('1. Restart dashboard if needed: sh scripts/service.sh restart')
    print('2. Start tunnel:              sh scripts/tunnel-ngrok.sh start')
    print('=' * 50)

    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\nAborted.')
        sys.exit(1)
    except RuntimeError as e:
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(f'ERROR: Command failed (exit {e.returncode})', file=sys.stderr)
        sys.exit(1)
