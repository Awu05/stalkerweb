plugins {
    alias(libs.plugins.android.library)
}

// The Solo app's native bridge (app/src/solo/cpp): starts nodejs-mobile's Node
// from Kotlin. A module of its own so that only the Solo variants depend on it
// — the remote apps run no CMake at all, and build without the NDK.
android {
    namespace = "com.stalkerweb.android.solonative"
    compileSdk = 37

    defaultConfig {
        minSdk = 26
        // The two ABIs Solo ships (libnode.so from android/scripts/fetch-libnode.sh).
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
        externalNativeBuild {
            cmake { arguments += listOf("-DSTALKERWEB_SOLO=ON", "-DANDROID_STL=c++_shared") }
        }
    }

    externalNativeBuild {
        cmake { path = file("../app/src/solo/cpp/CMakeLists.txt") }
    }
}
