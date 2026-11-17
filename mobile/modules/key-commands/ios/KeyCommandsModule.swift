import ExpoModulesCore
import UIKit

/// Hardware keyboard shortcuts for the player (iPad with a keyboard, and the Mac "Designed for iPad" build).
/// React Native has no key events on iOS, so the keys are registered as UIKeyCommands on the root view
/// controller and forwarded to JS as `onKey` events while JS listens.
public class KeyCommandsModule: Module {
  fileprivate static weak var current: KeyCommandsModule?

  private static let keys: [(input: String, name: String)] = [
    (" ", "space"),
    (UIKeyCommand.inputLeftArrow, "left"),
    (UIKeyCommand.inputRightArrow, "right"),
    (UIKeyCommand.inputEscape, "escape"),
  ]

  private var installed: [UIKeyCommand] = []
  private weak var host: UIViewController?

  public func definition() -> ModuleDefinition {
    Name("KeyCommands")
    Events("onKey")

    OnStartObserving {
      KeyCommandsModule.current = self
      DispatchQueue.main.async { self.install() }
    }

    OnStopObserving {
      DispatchQueue.main.async { self.uninstall() }
    }
  }

  fileprivate func send(_ command: UIKeyCommand) {
    guard let name = Self.keys.first(where: { $0.input == command.input })?.name else { return }
    sendEvent("onKey", ["key": name])
  }

  private func install() {
    uninstall()
    let window = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow } ?? UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first
    guard let root = window?.rootViewController else { return }
    for key in Self.keys {
      let command = UIKeyCommand(input: key.input, modifierFlags: [], action: #selector(UIViewController.animeStudyKeyCommand(_:)))
      // Without this, focused buttons and scroll views take Space and the arrow keys first.
      command.wantsPriorityOverSystemBehavior = true
      root.addKeyCommand(command)
      installed.append(command)
    }
    host = root
  }

  private func uninstall() {
    if let host {
      installed.forEach { host.removeKeyCommand($0) }
    }
    installed = []
    host = nil
  }
}

extension UIViewController {
  @objc func animeStudyKeyCommand(_ command: UIKeyCommand) {
    KeyCommandsModule.current?.send(command)
  }
}
