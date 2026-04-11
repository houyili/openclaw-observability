import Foundation
import Security

let keychainService = "openclaw.observability.ngrok-authtoken"
let itemLabel = "OpenClaw Observability ngrok Authtoken"

func saveToKeychain(_ token: String) -> Bool {
    // Delete existing
    let deleteQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
    ]
    SecItemDelete(deleteQuery as CFDictionary)

    // Add new
    let addQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
        kSecAttrLabel as String: itemLabel,
        kSecAttrAccount as String: "ngrok-authtoken",
        kSecValueData as String: Data(token.utf8),
    ]
    let status = SecItemAdd(addQuery as CFDictionary, nil)
    return status == errSecSuccess
}

func loadFromKeychain() -> String? {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
}

func deleteFromKeychain() -> Bool {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
    ]
    return SecItemDelete(query as CFDictionary) == errSecSuccess
}

// CLI
let args = CommandLine.arguments
if args.count < 2 {
    print("Usage: ngrok_keychain {install|get|delete|check}")
    exit(1)
}

switch args[1] {
case "install":
    print("Enter your ngrok authtoken (input is hidden):")
    // Read from stdin securely
    let token: String
    if let input = readLine(strippingNewline: true), !input.isEmpty {
        token = input.trimmingCharacters(in: .whitespacesAndNewlines)
    } else {
        print("ERROR: No token provided")
        exit(1)
    }
    if saveToKeychain(token) {
        print("OK: ngrok authtoken saved to macOS Keychain")
        print("Service: \(keychainService)")
    } else {
        print("ERROR: Failed to save to Keychain")
        exit(1)
    }

case "get":
    if let token = loadFromKeychain() {
        print(token)
    } else {
        print("ERROR: No ngrok authtoken found in Keychain")
        exit(1)
    }

case "delete":
    if deleteFromKeychain() {
        print("OK: Deleted from Keychain")
    } else {
        print("No entry found to delete")
    }

case "check":
    if let token = loadFromKeychain() {
        print("OK: Token found (\(token.prefix(8))...)")
    } else {
        print("NOT_FOUND: Run 'install' first")
        exit(1)
    }

default:
    print("Usage: ngrok_keychain {install|get|delete|check}")
    exit(1)
}
