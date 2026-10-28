plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// Version is injected by CI as -PversionName=X.Y.Z; falls back to default for local builds.
val appVersionName: String = (project.findProperty("versionName") as String?) ?: "0.1.1"
val versionParts = appVersionName.split(".").map { it.toIntOrNull() ?: 0 }
val appVersionCode = (versionParts.getOrElse(0) { 0 } * 10_000) +
                     (versionParts.getOrElse(1) { 0 } * 100) +
                     (versionParts.getOrElse(2) { 0 })

android {
    namespace = "com.stalkerweb.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.stalkerweb.android"
        minSdk = 26
        targetSdk = 37
        versionCode = appVersionCode.coerceAtLeast(1)
        versionName = appVersionName

        buildConfigField("String", "GITHUB_REPO", "\"Awu05/stalkerweb\"")
    }

    flavorDimensions += listOf("form", "backend")

    productFlavors {
        create("mobile") {
            dimension = "form"
            buildConfigField("Boolean", "IS_TV", "false")
        }
        create("tv") {
            dimension = "form"
            applicationIdSuffix = ".tv"
            buildConfigField("Boolean", "IS_TV", "true")
        }
        // Remote talks to a StalkerWeb server; Solo carries its own (the app's name and id differ so both can be installed).
        create("remote") {
            dimension = "backend"
            resValue("string", "app_name", "stalkerweb")
            buildConfigField("Boolean", "IS_SOLO", "false")
        }
        create("solo") {
            dimension = "backend"
            applicationIdSuffix = ".solo"
            resValue("string", "app_name", "StalkerWeb Solo")
            buildConfigField("Boolean", "IS_SOLO", "true")
        }
    }

    signingConfigs {
        create("release") {
            storeFile = file(System.getenv("KEYSTORE_PATH") ?: rootProject.file("debug.keystore"))
            storePassword = System.getenv("KEYSTORE_PASSWORD") ?: "android"
            keyAlias = System.getenv("KEY_ALIAS") ?: "androiddebugkey"
            keyPassword = System.getenv("KEY_PASSWORD") ?: "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        // False positive on Compose apps using registerForActivityResult on ComponentActivity
        // without Fragments. The Fragment version constraint doesn't apply here.
        disable += "InvalidFragmentVersionForActivityResult"
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.exoplayer.hls)
    implementation(libs.media3.session)
    implementation(libs.media3.ui)
    implementation(libs.retrofit)
    implementation(libs.retrofit.moshi)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.moshi.kotlin)
    implementation(libs.coil.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.mediarouter)
    implementation(libs.cast.framework)

    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
}

// Name every unit test in the build output, so CI logs show what ran.
tasks.withType<Test>().configureEach {
    testLogging { events("passed", "failed", "skipped") }
}
