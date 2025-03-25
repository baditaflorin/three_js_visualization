package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io" // Added for io.Copy
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	proxyPort      = ":8080"
	requestTimeout = 5 * time.Second
	iconTimeout    = 8 * time.Second // Slightly longer timeout for icon fetch
)

// CheckRequest and CheckResponse structs remain the same
type CheckRequest struct {
	URL  string `json:"url"`
	Port int    `json:"port"`
}
type CheckResponse struct {
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

func main() {
	mux := http.NewServeMux()

	// --- Register Endpoints with CORS ---
	// Check endpoint
	mux.Handle("/check", corsMiddleware(http.HandlerFunc(checkHandler)))
	// New Icon endpoint
	mux.Handle("/get-icon", corsMiddleware(http.HandlerFunc(iconHandler))) // Add icon handler

	log.Printf("Starting Go proxy on port %s\n", proxyPort)
	log.Printf(" - Check endpoint: http://localhost%s/check\n", proxyPort)
	log.Printf(" - Icon endpoint:  http://localhost%s/get-icon\n", proxyPort)

	server := &http.Server{
		Addr:         proxyPort,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Could not listen on %s: %v\n", proxyPort, err)
	}
}

// --- CORS Middleware (Remains the same) ---
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*") // Adjust for production
		// Allow GET for icons
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- checkHandler (Remains the same) ---
func checkHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost { /* ... */
		respondWithError(w, http.StatusMethodNotAllowed, "INVALID_REQUEST", "Only POST method is allowed")
		return
	}
	var req CheckRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil { /* ... */
		respondWithError(w, http.StatusBadRequest, "INVALID_REQUEST", fmt.Sprintf("Invalid JSON: %v", err))
		return
	}
	if req.URL == "" || req.Port <= 0 || req.Port > 65535 { /* ... */
		respondWithError(w, http.StatusBadRequest, "INVALID_REQUEST", "Missing/invalid URL/Port")
		return
	}
	targetURL, err := constructTargetURL(req.URL, req.Port)
	if err != nil { /* ... */
		respondWithError(w, http.StatusBadRequest, "INVALID_REQUEST", fmt.Sprintf("Invalid URL format: %v", err))
		return
	}
	log.Printf("Proxy checking: %s", targetURL)
	client := &http.Client{Timeout: requestTimeout}
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodHead, targetURL, nil)
	if err != nil { /* ... */
		respondWithError(w, http.StatusInternalServerError, "ERROR", fmt.Sprintf("Req creation failed: %v", err))
		return
	}
	httpReq.Header.Set("User-Agent", "Go-HTTP-Monitor-Client/1.0")
	resp, err := client.Do(httpReq)
	if err != nil { /* ... Handle timeout and other errors ... */
		if urlErr, ok := err.(*url.Error); ok && urlErr.Timeout() {
			log.Printf("Timeout checking %s", targetURL)
			respondWithSuccess(w, "TIMEOUT", "HEAD request timed out")
			return
		}
		if err == context.DeadlineExceeded {
			log.Printf("Timeout checking %s", targetURL)
			respondWithSuccess(w, "TIMEOUT", "HEAD request timed out")
			return
		}
		log.Printf("Error checking %s: %v", targetURL, err)
		respondWithSuccess(w, "ERROR", fmt.Sprintf("Network error: %v", err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 { /* ... */
		log.Printf("OK checking %s (Status: %d)", targetURL, resp.StatusCode)
		respondWithSuccess(w, "OK", fmt.Sprintf("Status code: %d", resp.StatusCode))
	} else { /* ... */
		log.Printf("Error status checking %s (Status: %d)", targetURL, resp.StatusCode)
		respondWithSuccess(w, "ERROR", fmt.Sprintf("Non-2xx status code: %d", resp.StatusCode))
	}
}

// --- NEW: iconHandler ---
func iconHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Only GET method is allowed", http.StatusMethodNotAllowed)
		return
	}

	targetBaseURL := r.URL.Query().Get("url")
	if targetBaseURL == "" {
		http.Error(w, "Missing 'url' query parameter", http.StatusBadRequest)
		return
	}

	// Ensure base URL has scheme
	if !strings.HasPrefix(targetBaseURL, "http://") && !strings.HasPrefix(targetBaseURL, "https://") {
		targetBaseURL = "https://" + targetBaseURL // Default to HTTPS if scheme missing
	}

	parsedBaseURL, err := url.Parse(targetBaseURL)
	if err != nil {
		http.Error(w, fmt.Sprintf("Invalid base URL: %v", err), http.StatusBadRequest)
		return
	}

	// Construct the /favicon.ico URL
	// Use Scheme + Host only, ignore path/query from original URL
	faviconURL := fmt.Sprintf("%s://%s/favicon.ico", parsedBaseURL.Scheme, parsedBaseURL.Host)

	log.Printf("Proxy fetching icon: %s", faviconURL)

	client := &http.Client{
		Timeout: iconTimeout, // Use specific timeout for icons
	}

	ctx, cancel := context.WithTimeout(context.Background(), iconTimeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, faviconURL, nil)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to create icon request: %v", err), http.StatusInternalServerError)
		return
	}
	httpReq.Header.Set("User-Agent", "Go-HTTP-Monitor-Client/1.0 (Icon Fetch)")

	resp, err := client.Do(httpReq)
	if err != nil {
		// Handle timeout specifically
		if urlErr, ok := err.(*url.Error); ok && urlErr.Timeout() {
			log.Printf("Timeout fetching icon %s", faviconURL)
			http.Error(w, "Icon fetch timed out", http.StatusRequestTimeout)
			return
		}
		if err == context.DeadlineExceeded {
			log.Printf("Timeout fetching icon %s", faviconURL)
			http.Error(w, "Icon fetch timed out", http.StatusRequestTimeout)
			return
		}

		log.Printf("Error fetching icon %s: %v", faviconURL, err)
		http.Error(w, fmt.Sprintf("Failed to fetch icon: %v", err), http.StatusBadGateway) // 502 might be appropriate
		return
	}
	defer resp.Body.Close()

	// Check if response looks like an image and is successful
	contentType := resp.Header.Get("Content-Type")
	isImage := strings.HasPrefix(contentType, "image/") || contentType == "image/x-icon" || contentType == "image/vnd.microsoft.icon"

	if resp.StatusCode >= 200 && resp.StatusCode < 300 && isImage {
		log.Printf("Icon fetched successfully: %s (Content-Type: %s)", faviconURL, contentType)
		// Set Content-Type for the response back to the browser
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "public, max-age=86400") // Cache icon for a day
		// Stream the icon data
		_, err = io.Copy(w, resp.Body)
		if err != nil {
			log.Printf("Error streaming icon data for %s: %v", faviconURL, err)
			// Don't write http.Error here as headers might be partially written
		}
	} else {
		log.Printf("Failed to get valid icon for %s (Status: %d, Content-Type: %s)", faviconURL, resp.StatusCode, contentType)
		http.Error(w, "Favicon not found or invalid", http.StatusNotFound)
	}
}

// --- Helpers (constructTargetURL, respondWithError, respondWithSuccess - Remain the same) ---
func constructTargetURL(baseURL string, port int) (string, error) { /* ... no change ... */
	parsedURL, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	if !strings.Contains(parsedURL.Host, ":") {
		isStandardPort := (parsedURL.Scheme == "http" && port == 80) || (parsedURL.Scheme == "https" && port == 443)
		if !isStandardPort {
			parsedURL.Host = net.JoinHostPort(parsedURL.Host, strconv.Itoa(port))
		}
	} else {
		host, existingPortStr, err := net.SplitHostPort(parsedURL.Host)
		if err == nil {
			existingPort, _ := strconv.Atoi(existingPortStr)
			if existingPort != port {
				parsedURL.Host = net.JoinHostPort(host, strconv.Itoa(port))
			}
		} else {
			if (parsedURL.Scheme == "http" && port != 80) || (parsedURL.Scheme == "https" && port != 443) {
				parsedURL.Host = net.JoinHostPort(parsedURL.Host, strconv.Itoa(port))
			}
		}
	}
	return parsedURL.String(), nil
}
func respondWithError(w http.ResponseWriter, statusCode int, status string, detail string) { /* ... no change ... */
	response := CheckResponse{Status: status, Detail: detail}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(response)
}
func respondWithSuccess(w http.ResponseWriter, status string, detail string) { /* ... no change ... */
	response := CheckResponse{Status: status, Detail: detail}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
}
