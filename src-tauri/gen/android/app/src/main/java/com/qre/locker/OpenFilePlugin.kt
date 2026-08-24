package com.qre.locker

import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class OpenFileArgs {
  lateinit var path: String
}

// Replaces tauri-plugin-opener's own open_path on Android, which is broken as of 2.5.4: its
// mobile implementation sends the path as a bare JSON string, but the Kotlin side can only
// deserialize an object with a `url` field (it reuses the same "open" command as open_url,
// with no path-specific handling at all) - so every call fails with a Jackson deserialization
// error before any file-opening logic runs. This plugin builds a proper content:// URI via
// FileProvider (see the <provider> entry in AndroidManifest.xml and res/xml/file_paths.xml)
// and launches a correctly MIME-typed ACTION_VIEW intent instead.
@TauriPlugin
class OpenFilePlugin(private val activity: android.app.Activity) : Plugin(activity) {
  @Command
  fun openFile(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(OpenFileArgs::class.java)
      val file = File(args.path)
      val authority = "${activity.applicationContext.packageName}.fileprovider"
      val uri = FileProvider.getUriForFile(activity, authority, file)
      val mimeType = MimeTypeMap.getSingleton()
        .getMimeTypeFromExtension(file.extension.lowercase())
        ?: "*/*"

      val intent = Intent(Intent.ACTION_VIEW)
      intent.setDataAndType(uri, mimeType)
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.applicationContext.startActivity(intent)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }
}
