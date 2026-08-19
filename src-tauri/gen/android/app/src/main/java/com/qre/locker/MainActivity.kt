package com.qre.locker

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge() // Keep this line since it's working for you
    super.onCreate(savedInstanceState)

    // ADD THIS: Check for permissions on startup
    checkPermissions()
  }

  // Re-check on every resume, not just cold start. onCreate() only fires once, so a user who
  // dismissed the "All Files Access" prompt without granting it (or revoked it later in
  // Settings) would never be asked again for the rest of the app's install lifetime, and every
  // subsequent directory read would keep silently failing with a permission error.
  override fun onResume() {
    super.onResume()
    checkPermissions()
  }

  // ADD THIS FUNCTION
  private fun checkPermissions() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (!Environment.isExternalStorageManager()) {
        try {
            val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
            intent.addCategory("android.intent.category.DEFAULT")
            intent.data = Uri.parse(String.format("package:%s", applicationContext.packageName))
            startActivity(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
      }
    }
  }
}
