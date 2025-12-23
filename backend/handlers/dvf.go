package handlers

import (
	"fmt"
	"io"
	"net/http"
)

// GetDVF récupère l'historique des mutations (ventes) pour une parcelle spécifique
func GetDVF(w http.ResponseWriter, r *http.Request) {
	idParcelle := r.URL.Query().Get("id_parcelle")
	if idParcelle == "" {
		http.Error(w, "Paramètre id_parcelle manquant", http.StatusBadRequest)
		return
	}

	// Utilisation de l'API DVF d'Etalab
	url := fmt.Sprintf("https://dvf-api.data.gouv.fr/dvf/mutation/?code_parcelle=%s", idParcelle)

	resp, err := http.Get(url)
	if err != nil {
		http.Error(w, "Erreur lors de l'appel à l'API DVF", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	io.Copy(w, resp.Body)
}
