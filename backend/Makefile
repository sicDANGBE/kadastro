# ==============================================================================
# KLARO - Project Makefile
# Orchestration: User
# Implementation: Gemini
# ==============================================================================

# Variables de projet
PROJECT_NAME := klaro
BACKEND_DIR := backend
FRONTEND_DIR := frontend

# Détection de l'OS pour les commandes spécifiques (optionnel mais propre)
GO := go
PNPM := pnpm

.PHONY: all init dev build clean docker-build help

# Par défaut, on affiche l'aide
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  init        Initialise la structure (Go module, Vue app, Pnpm workspace)"
	@echo "  dev         Lance le serveur Go (avec Air) et Vite en parallèle"
	@echo "  build       Compile le binaire Go et build le Frontend"
	@echo "  docker      Construit l'image Docker optimisée"
	@echo "  clean       Nettoie les artefacts de build"

# ==============================================================================
# 1. INITIALISATION
# ==============================================================================
init:
	@echo "🚀 Initialisation de Klaro..."
	
	# 1. Création des dossiers
	mkdir -p $(BACKEND_DIR)
	
	# 2. Setup Backend (Go)
	@echo "⚙️  Setup Backend (Go)..."
	# On ignore l'erreur si le mod existe déjà (|| true)
	cd $(BACKEND_DIR) && $(GO) mod init github.com/sicDANGBE/$(PROJECT_NAME) || true
	cd $(BACKEND_DIR) && $(GO) get -u github.com/go-chi/chi/v5 gorm.io/gorm gorm.io/driver/sqlite
	@if ! command -v air > /dev/null; then \
		echo "📦 Installation de Air (Live Reload)..."; \
		$(GO) install github.com/air-verse/air@latest; \
	fi

	# 3. Setup Frontend (Vue + Vite + Tailwind)
	@echo "🎨 Setup Frontend (Vue.js)..."
	# Si le dossier existe déjà, create vite va échouer, on check avant
	@if [ ! -d "$(FRONTEND_DIR)/src" ]; then \
		$(PNPM) create vite $(FRONTEND_DIR) --template vue-ts; \
	fi
	
	# 4. Setup Workspace & Deps
	@echo "🔗 Setup Workspace..."
	echo "packages:\n  - 'frontend'" > pnpm-workspace.yaml
	
	# Installation propre avec pnpm
	cd $(FRONTEND_DIR) && $(PNPM) install
	cd $(FRONTEND_DIR) && $(PNPM) install -D tailwindcss postcss autoprefixer
	
	# CORRECTION ICI: On utilise pnpm pour executer le binaire local
	cd $(FRONTEND_DIR) && $(PNPM) dlx tailwindcss init -p

	@echo "✅ Initialisation terminée ! Lance 'make dev' pour démarrer."

# ==============================================================================
# 2. DEVELOPPEMENT
# ==============================================================================
dev:
	@echo "🔥 Lancement de l'environnement de dev..."
	# On utilise make -j2 pour lancer les deux processus en parallèle
	# Le backend écoute sur le port 8080, le front sur 5173
	make -j2 dev-back dev-front

dev-back:
	@echo "🐘 Backend (Go + Air)..."
	cd $(BACKEND_DIR) && $$(go env GOPATH)/bin/air

dev-front:
	@echo "✨ Frontend (Vite)..."
	cd $(FRONTEND_DIR) && $(PNPM) dev

# ==============================================================================
# 3. BUILD & DOCKER
# ==============================================================================
docker:
	@echo "🐳 Construction de l'image Docker sécurisée..."
	docker build -t $(PROJECT_NAME):latest .