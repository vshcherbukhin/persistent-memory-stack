// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Vladimir Shcherbukhin
package main

import (
	"net/http"
	"os"
	"time"
)

func healthy(client *http.Client, base string) bool {
	for _, path := range []string{"/minio/health/live", "/minio/health/ready"} {
		request, err := http.NewRequest(http.MethodGet, base+path, nil)
		if err != nil {
			return false
		}
		request.Close = true
		response, err := client.Do(request)
		if err != nil {
			return false
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return false
		}
	}
	return true
}

func main() {
	client := &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	if !healthy(client, "http://127.0.0.1:9000") {
		os.Exit(1)
	}
}
