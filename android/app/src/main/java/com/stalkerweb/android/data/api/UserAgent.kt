package com.stalkerweb.android.data.api

import com.stalkerweb.android.BuildConfig

/**
 * What the app calls itself to the server — its API calls and its player's
 * streams alike, so Settings → Activity names it ("StalkerWeb TV app") and
 * matches its streams to the viewer its API calls name. Android's default
 * ("Dalvik/2.1.0 …") says only "an Android device".
 */
val APP_USER_AGENT: String = "StalkerWeb-Android/${BuildConfig.VERSION_NAME} (${if (BuildConfig.IS_TV) "TV" else "phone"})"
