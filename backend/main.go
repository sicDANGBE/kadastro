package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/sicDANGBE/kadastro/handlers"
)

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/cadastre", handlers.GetParcelles)
	mux.HandleFunc("/api/dvf", handlers.GetDVF)
	mux.HandleFunc("/api/dvf/commune", handlers.GetDVFByCommune)

	fmt.Println("🚀 Kadastro API ready on http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", corsMiddleware(mux)))
}
