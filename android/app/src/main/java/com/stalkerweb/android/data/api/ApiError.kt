package com.stalkerweb.android.data.api

import com.squareup.moshi.JsonClass
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import retrofit2.HttpException
import java.io.IOException

/** What went wrong talking to the server, with the server's own message where it gave one. */
sealed class ApiError(message: String) : Exception(message) {
    /** The access gate refused the key (401 with accessRequired). */
    class AccessDenied(message: String) : ApiError(message)
    /** Too many wrong keys from here (429); the message says how long to wait. */
    class LockedOut(message: String) : ApiError(message)
    /** This device's viewer was deleted (409 with viewerGone). */
    class ViewerGone : ApiError("This viewer was deleted. Pick who is watching.")
    /** No answer at all: wrong address, server down, no network. */
    class Unreachable(message: String) : ApiError(message)
    class Failed(message: String) : ApiError(message)
}

/** The JSON error body the server sends ({ error, accessRequired, viewerGone }). */
@JsonClass(generateAdapter = false)
data class ErrorBody(
    val error: String? = null,
    val accessRequired: Boolean? = null,
    val viewerGone: Boolean? = null,
)

private val errorAdapter = Moshi.Builder().addLast(KotlinJsonAdapterFactory()).build().adapter(ErrorBody::class.java)

internal fun parseErrorBody(body: String?): ErrorBody =
    body?.let { runCatching { errorAdapter.fromJson(it) }.getOrNull() } ?: ErrorBody()

fun apiErrorFor(code: Int, body: String?): ApiError {
    val b = parseErrorBody(body)
    val message = b.error?.takeIf { it.isNotBlank() }
    return when {
        code == 409 && b.viewerGone == true -> ApiError.ViewerGone()
        code == 401 && b.accessRequired == true -> ApiError.AccessDenied(message ?: "Access key required.")
        code == 429 -> ApiError.LockedOut(message ?: "Too many wrong access keys — try again later.")
        else -> ApiError.Failed(message ?: "HTTP $code")
    }
}

/** Any failure from a request, as an [ApiError]. Reads (and so uses up) an HTTP error's body. */
fun Throwable.toApiError(): ApiError = when (this) {
    is ApiError -> this
    is HttpException -> apiErrorFor(code(), runCatching { response()?.errorBody()?.string() }.getOrNull())
    is IOException -> ApiError.Unreachable("Can't reach the server.")
    else -> ApiError.Failed(message ?: "Something went wrong.")
}
