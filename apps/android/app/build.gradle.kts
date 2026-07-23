import org.gradle.api.tasks.Copy

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "org.zalikus.messenger"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.zalikus.messenger"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.02")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    // Native API/WebSocket bridge (NativeBridge.kt) — HTTP client + WS client to
    // sidestep the WebView's CORS enforcement on file:// pages (see class doc).
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // WebViewCompat.addDocumentStartJavaScript — injects the bridge before the
    // page's own scripts run, matching iOS's WKUserScript(.atDocumentStart).
    implementation("androidx.webkit:webkit:1.12.1")
}

// Copy the shared web bundle (produced by `python3 scripts/bundle_web.py`) into
// assets before every build, so the WebView always loads the current UI.
val copyWebAssets by tasks.registering(Copy::class) {
    from(rootProject.projectDir.parentFile.parentFile.resolve("web")) {
        include("index.html", "style.css", "app.js")
    }
    into(layout.projectDirectory.dir("src/main/assets/web"))
}
tasks.named("preBuild") { dependsOn(copyWebAssets) }
