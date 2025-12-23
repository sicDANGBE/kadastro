package handlers

import (
	"fmt"
	"io"
	"net/http"
)

// GetParcelles récupère les données GeoJSON du cadastre pour une commune donnée
func GetParcelles(w http.ResponseWriter, r *http.Request) {
	codeInsee := r.URL.Query().Get("code_insee")
	if codeInsee == "" {
		http.Error(w, "Paramètre code_insee manquant", http.StatusBadRequest)
		return
	}

	url := fmt.Sprintf("https://cadastre.data.gouv.fr/bundler/cadastre-etalab/communes/%s/geojson/parcelles", codeInsee)

	resp, err := http.Get(url)
	if err != nil {
		http.Error(w, "Erreur lors de l'appel à l'API Cadastre", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		http.Error(w, "Commune non trouvée ou erreur API source", resp.StatusCode)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	io.Copy(w, resp.Body)
}
