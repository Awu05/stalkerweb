package com.stalkerweb.android.data.repo

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RequestOrderTest {
    @Test fun aStaleAnswerDoesNotUndoALaterLocalChange() {
        val order = RequestOrder()
        val save = order.next(local = false)   // progress save in flight
        val add = order.next(local = true)     // My List change made here
        assertFalse(order.accept(save))        // its answer has the old list
        assertTrue(order.accept(add))
    }

    @Test fun anOlderAnswerDoesNotReplaceANewerOne() {
        val order = RequestOrder()
        val first = order.next(local = false)
        val second = order.next(local = false)
        assertTrue(order.accept(second))
        assertFalse(order.accept(first))
    }
}
