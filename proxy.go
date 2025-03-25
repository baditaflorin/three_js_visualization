package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	proxyPort      = ":8080"         // Port the proxy listens on
	requestTimeout = 5 * time.Second // Timeout for checking target endpoints
)

// Structure for the incoming request from the browser
type CheckRequest struct {
	URL  string `json:"url"` // Should include scheme (http/https)
	Port int    `json:"port"`
}

// Structure for the response sent back to the browser
type CheckResponse struct {
	Status string `json:"status"`           // "OK", "ERROR", "TIMEOUT", "INVALID_REQUEST"
	Detail string `json:"detail,omitempty"` // Optional extra info
}

func main() {
	mux := http.NewServeMux()
	// Wrap checkHandler with CORS middleware
	mux.Handle("/check", corsMiddleware(http.HandlerFunc(checkHandler)))

	log.Printf("Starting Go proxy on port %s\n", proxyPort)
	log.Printf("Frontend should send requests to http://localhost%s/check\n", proxyPort)

	// Start the server
	server := &http.Server{
		Addr:         proxyPort,
		Handler:      mux,
		ReadTimeout:  5 * time.Second, // Add basic timeouts for the proxy itself
		WriteTimeout: 10 * time.Second,
	}

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Could not listen on %s: %v\n", proxyPort, err)
	}
}

// Middleware to add CORS headers
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Allow requests from any origin (for development)
		// In production, restrict this to the specific origin of your frontend
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		// Handle preflight requests (OPTIONS method)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		// Call the next handler in the chain
		next.ServeHTTP(w, r)
	})
}

// Handles the /check endpoint
func checkHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		respondWithError(w, http.StatusMethodNotAllowed, "INVALID_REQUEST", "Only POST method is allowed")
		return
	}

	// Decode the request body
	var req CheckRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields() // Prevent unexpected fields
	err := decoder.Decode(&req)
	if err != nil {
		respondWithError(w, http.StatusBadRequest, "INVALID_REQUEST", fmt.Sprintf("Invalid JSON request: %v", err))
		return
	}

	// Validate input
	if req.URL == "" || req.Port <= 0 || req.Port > 65535 {
		respondWithError(w, http.StatusBadRequest, "INVALID_REQUEST", "Missing or invalid URL/Port")
		return
	}

	// Construct the target URL, potentially adding the port
	targetURL, err := constructTargetURL(req.URL, req.Port)
	if err != nil {
		respondWithError(w, http.StatusBadRequest, "INVALID_REQUEST", fmt.Sprintf("Invalid URL format: %v", err))
		return
	}

	log.Printf("Proxy checking: %s", targetURL)

	// Perform the HEAD request
	client := &http.Client{
		Timeout: requestTimeout, // Apply timeout
	}

	// Create a context for the request timeout
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel() // Ensure cancellation happens

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodHead, targetURL, nil)
	if err != nil {
		respondWithError(w, http.StatusInternalServerError, "ERROR", fmt.Sprintf("Failed to create request: %v", err))
		return
	}
	// Add a User-Agent to look like a regular browser (optional)
	httpReq.Header.Set("User-Agent", "Go-HTTP-Monitor-Client/1.0")

	resp, err := client.Do(httpReq)

	// Handle different error types
	if err != nil {
		// Check for context deadline exceeded (timeout)
		if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
			log.Printf("Timeout checking %s", targetURL)
			respondWithSuccess(w, "TIMEOUT", "Request timed out")
			return
		}
		// Check for URL parsing errors or context cancellation (which wraps timeout)
		if urlErr, ok := err.(*url.Error); ok {
			if urlErr.Timeout() {
				log.Printf("Timeout checking %s (url.Error)", targetURL)
				respondWithSuccess(w, "TIMEOUT", "Request timed out")
				return
			}
		}
		// Check specifically for context deadline exceeded error
		if err == context.DeadlineExceeded {
			log.Printf("Timeout checking %s (context.DeadlineExceeded)", targetURL)
			respondWithSuccess(w, "TIMEOUT", "Request timed out")
			return
		}

		// Other general errors (DNS lookup failure, connection refused, etc.)
		log.Printf("Error checking %s: %v", targetURL, err)
		respondWithSuccess(w, "ERROR", fmt.Sprintf("Network error: %v", err))
		return
	}

	// We got a response, close the body (important!)
	defer resp.Body.Close()

	// Check the status code (2xx is considered OK for HEAD)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		log.Printf("OK checking %s (Status: %d)", targetURL, resp.StatusCode)
		respondWithSuccess(w, "OK", fmt.Sprintf("Status code: %d", resp.StatusCode))
	} else {
		log.Printf("Error status checking %s (Status: %d)", targetURL, resp.StatusCode)
		respondWithSuccess(w, "ERROR", fmt.Sprintf("Non-2xx status code: %d", resp.StatusCode))
	}
}

// Helper to construct the final URL, adding port if needed
func constructTargetURL(baseURL string, port int) (string, error) {
	parsedURL, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}

	if !strings.Contains(parsedURL.Host, ":") { // Host doesn't already contain a port
		isStandardPort := (parsedURL.Scheme == "http" && port == 80) || (parsedURL.Scheme == "https" && port == 443)
		if !isStandardPort {
			parsedURL.Host = net.JoinHostPort(parsedURL.Host, strconv.Itoa(port))
		}
	} else {
		// Host contains a port, check if it matches the input port
		host, existingPortStr, err := net.SplitHostPort(parsedURL.Host)
		if err != nil {
			// If SplitHostPort fails, maybe it's just a hostname without port yet
			if (parsedURL.Scheme == "http" && port != 80) || (parsedURL.Scheme == "https" && port != 443) {
				parsedURL.Host = net.JoinHostPort(parsedURL.Host, strconv.Itoa(port))
			}
		} else {
			existingPort, _ := strconv.Atoi(existingPortStr)
			if existingPort != port {
				// Input port overrides the one in the URL
				parsedURL.Host = net.JoinHostPort(host, strconv.Itoa(port))
			}
			// If ports match, do nothing, keep the original host string
		}
	}

	return parsedURL.String(), nil
}

// Helper to send JSON error responses
func respondWithError(w http.ResponseWriter, statusCode int, status string, detail string) {
	response := CheckResponse{
		Status: status,
		Detail: detail,
	}
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(response)
}

// Helper to send JSON success responses
func respondWithSuccess(w http.ResponseWriter, status string, detail string) {
	response := CheckResponse{
		Status: status,
		Detail: detail,
	}
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
}
