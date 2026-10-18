package com.qre.locker

import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
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

@InvokeArg
class SystemBarsArgs {
  var lightBackground: Boolean = false
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

  // Chooses dark or light icons for the status bar (time, signal, battery) and the navigation
  // bar. With edge-to-edge drawing, Android picks them from the PHONE's dark mode, not from the
  // app's theme: a phone in dark mode shows white icons, which vanish when the app is set to its
  // light theme. The web side calls this whenever the app's own theme changes. A light app
  // background needs dark icons, which is what "light bars" means in Android's wording.
  @Command
  fun setSystemBars(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SystemBarsArgs::class.java)
      activity.runOnUiThread {
        val window = activity.window
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = args.lightBackground
        controller.isAppearanceLightNavigationBars = args.lightBackground
      }
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }
}
