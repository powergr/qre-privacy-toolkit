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
  }

  // Checked here rather than (or in addition to) onCreate(): the standard Android lifecycle
  // always runs onCreate() -> onStart() -> onResume() in sequence on every launch, including
  // the very first one - so onResume() alone already covers a cold start. Having the check in
  // both onCreate() and onResume() fired it twice on every launch (both calls happen before
  // the user gets a chance to respond, so the permission is still ungranted for both), which
  // popped the "All Files Access" prompt twice in a row. Checking only in onResume() covers
  // both cases with one call: the initial launch, and a user who dismissed the prompt earlier
  // (or revoked the permission later in Settings) returning to the app without having granted
  // it - they'd otherwise never be asked again for the rest of the install's lifetime, and
  // every directory read would keep silently failing with a permission error.
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
