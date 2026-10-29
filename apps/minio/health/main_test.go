// SPDX-License-Identifier: MIT
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHealthRequiresBothLiveAndReady(t *testing.T) {
	for _, failing := range []string{"", "/minio/health/live", "/minio/health/ready"} {
		t.Run(failing, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == failing {
					w.WriteHeader(http.StatusServiceUnavailable)
				}
			}))
			defer server.Close()
			if got := healthy(&http.Client{Timeout: time.Second}, server.URL); got != (failing == "") {
				t.Fatalf("health=%v for failing endpoint %q", got, failing)
			}
		})
	}
}

func TestHealthDoesNotTreatAConnectionFailureAsReady(t *testing.T) {
	if healthy(&http.Client{Timeout: 20 * time.Millisecond}, "http://127.0.0.1:1") {
		t.Fatal("unreachable server reported healthy")
	}
}
