package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.ViewerSummary
import org.junit.Assert.assertEquals
import org.junit.Test

class ViewerChoiceTest {
    private val a = ViewerSummary("view_a", "Andy")
    private val b = ViewerSummary("view_b", "Sam")

    @Test fun theAdminAndTheLastViewerCantBeDeleted() {
        val admin = ViewerSummary("view_a", "Andy", admin = true)
        assertEquals(true, canRemoveViewer(b, listOf(admin, b)))
        assertEquals(false, canRemoveViewer(admin, listOf(admin, b)))
        assertEquals(false, canRemoveViewer(b, listOf(b)))
        val def = ViewerSummary("view_d", "Default", isDefault = true)
        assertEquals(false, canRemoveViewer(def, listOf(admin, b, def)))
    }

    @Test fun onlyTheAdminMakesSomeoneElseTheAdmin() {
        val admin = ViewerSummary("view_a", "Andy", admin = true)
        val kim = ViewerSummary("view_k", "Kim")
        assertEquals(true, canMakeAdmin(b, listOf(admin, b, kim), "view_a"))
        assertEquals(false, canMakeAdmin(admin, listOf(admin, b, kim), "view_a"))
        assertEquals(false, canMakeAdmin(kim, listOf(admin, b, kim), "view_b"))
        assertEquals(false, canMakeAdmin(kim, listOf(admin, b, kim), null))
    }

    @Test fun keepsTheSavedViewerWhileItExists() {
        assertEquals(ViewerChoice("view_b", false), chooseViewer(listOf(a, b), "view_b"))
    }

    @Test fun asksWhenNoneIsSavedOrTheSavedOneIsGone() {
        assertEquals(ViewerChoice(null, true), chooseViewer(listOf(a, b), null))
        assertEquals(ViewerChoice(null, true), chooseViewer(listOf(a, b), "view_gone"))
    }

    @Test fun asksEvenWhenThereIsOnlyOne() {
        assertEquals(ViewerChoice(null, true), chooseViewer(listOf(a), null))
    }
}
