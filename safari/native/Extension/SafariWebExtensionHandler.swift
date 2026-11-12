import Foundation

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        // Learning and storage use Safari's extension APIs; native messaging is not needed.
        context.completeRequest(returningItems: [], completionHandler: nil)
    }
}
