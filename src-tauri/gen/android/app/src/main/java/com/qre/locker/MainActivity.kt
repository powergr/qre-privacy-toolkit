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
