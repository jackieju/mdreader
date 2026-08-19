import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers

struct ResolveBookmarkArgs: Decodable {
  let bookmark: String
}

// Holds the currently-accessed security-scoped folder URL for the app's
// lifetime. iOS grants folder access only while startAccessingSecurityScopedResource
// is balanced-open, so we retain the URL here (stopping the previous one on each
// new pick/resolve) to keep the vault readable by the Rust std::fs layer.
final class ScopedFolderHolder {
  static let shared = ScopedFolderHolder()
  private var current: URL?

  func retain(_ url: URL) {
    if let old = current, old != url {
      old.stopAccessingSecurityScopedResource()
    }
    current = url
  }
}

class FolderPickerPlugin: Plugin, UIDocumentPickerDelegate {
  var onResult: ((URL?) -> Void)?

  @objc public func pickFolder(_ invoke: Invoke) throws {
    onResult = { [weak self] (url: URL?) -> Void in
      guard let self = self else { return }
      guard let url = url else {
        invoke.resolve(["path": "", "bookmark": ""])
        return
      }
      self.finish(url, invoke)
    }

    DispatchQueue.main.async {
      guard #available(iOS 14.0, *) else {
        invoke.reject("folder picking requires iOS 14 or newer")
        return
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
      picker.allowsMultipleSelection = false
      picker.delegate = self
      self.manager.viewController?.present(picker, animated: true, completion: nil)
    }
  }

  @objc public func resolveFolderBookmark(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ResolveBookmarkArgs.self)
    guard let data = Data(base64Encoded: args.bookmark) else {
      invoke.reject("invalid bookmark data")
      return
    }
    var stale = false
    do {
      let url = try URL(
        resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
      guard url.startAccessingSecurityScopedResource() else {
        invoke.reject("could not access saved folder")
        return
      }
      ScopedFolderHolder.shared.retain(url)
      invoke.resolve(["path": url.path])
    } catch {
      invoke.reject("could not resolve bookmark: \(error.localizedDescription)")
    }
  }

  private func finish(_ url: URL, _ invoke: Invoke) {
    guard url.startAccessingSecurityScopedResource() else {
      invoke.reject("could not access selected folder")
      return
    }
    ScopedFolderHolder.shared.retain(url)
    do {
      let data = try url.bookmarkData(
        options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
      invoke.resolve(["path": url.path, "bookmark": data.base64EncodedString()])
    } catch {
      invoke.resolve(["path": url.path, "bookmark": ""])
    }
  }

  public func documentPicker(
    _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
  ) {
    onResult?(urls.first)
    onResult = nil
  }

  public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    onResult?(nil)
    onResult = nil
  }
}

@_cdecl("init_plugin_folder_picker")
func initPlugin() -> Plugin {
  return FolderPickerPlugin()
}
