# 📘 RELEASE_PROCESS.md

# 🚀 Canevas de Déploiement & Release — Klaro

Ce document décrit le cycle de vie de l’application.

**Philosophie :** Docker Hub reste propre. **Seules les versions taguées (releases)** génèrent une image Docker et un déploiement.

---

## 1. 🏗️ Architecture CI/CD

Le pipeline est divisé pour garantir la qualité avant la production.

| Étape              | Trigger                 | Exécuté par              | Action                                                                  |
| ------------------ | ----------------------- | ------------------------ | ----------------------------------------------------------------------- |
| 1. CI (Quality)    | Push `main` / PR        | GitHub Runners           | Linter, tests unitaires, build check. **Aucune image n’est poussée.**   |
| 2. Build & Release | **Tag `v*` uniquement** | GitHub Runners           | Construit l’image, **push** sur Docker Hub, crée la **Release GitHub**. |
| 3. Deploy          | Succès du Build         | Self-Hosted Runner (K3s) | Le cluster tire la nouvelle image taguée et met à jour les pods.        |

---

## 2. 🛡️ Discipline de Branche

⚠️ **Note importante :** le plan GitHub actuel ne permet pas le blocage technique des pushs.
Nous appliquons donc une protection par discipline.

* Interdiction de push directement sur `main` sans avoir testé localement (`make dev`).
* La branche `main` doit toujours être dans un état stable (**deployable**).
* Toute nouvelle fonctionnalité devrait idéalement être développée dans une branche `feat/ma-feature`, puis mergée dans `main`.

---

## 3. 🛠️ Flux de Développement (Features)

Pour toute modification (**hors hotfix critique**), on passe par une branche dédiée.

### 3.1 Création de la branche

```bash
# Partir de main à jour
git checkout main
git pull

# Créer la branche (Convention: feat/..., fix/..., chore/...)
git checkout -b feat/ma-nouvelle-feature
```

### 3.2 Développement & Push

```bash
# ... Coding ...
git add .
git commit -m "feat: Description de la feature"

# Premier push (configure le lien avec l'origine)
git push -u origin feat/ma-nouvelle-feature
```

### 3.3 Pull Request & Merge (via GitHub CLI)

```bash
# Créer la Pull Request vers main
# (Si c'est la première fois, utilise 'gh repo set-default saasMsDGH/klaro')
gh pr create --title "feat: Ma Feature" --body "Description des changements..."

# Une fois la CI (Quality) passée au vert :
# Merger en mode 'Squash' (1 seul commit sur main) et supprimer la branche distante
gh pr merge --squash --delete-branch
```

### 3.4 Retour sur main

```bash
git checkout main
git pull
# Ton local est maintenant à jour avec ta feature intégrée
```

---

## 4. 🔄 Procédure de Release (Mise en Prod)

C’est **l’unique méthode** pour mettre à jour la production.

**Source de vérité :** `package.json`.

### Pré-requis

* Être sur la branche `main` à jour.
* Avoir un arbre de travail propre (`git status` clean).
* Les tests locaux passent.

### Commandes à exécuter

```bash
# 1. Incrémenter la version (Patch: 0.0.1 -> 0.0.2)
# Cette commande met à jour package.json SANS créer de tag git tout de suite
npm version patch --no-git-tag-version

# 2. Vérifier la version
grep version package.json

# 3. Commiter le changement de version
git add package.json
git commit -m "chore: Bump version to $(jq -r .version package.json)"
git push origin main

# 4. Créer et pousser le tag (c’est le DÉCLENCHEUR du déploiement)
# Le tag DOIT correspondre à la version du package.json avec un 'v' devant
VERSION=$(jq -r .version package.json)
git tag v$VERSION
git push origin v$VERSION
```

---

## 5. 🔍 Vérifications Post-Déploiement

Une fois le workflow **« Build & Release (Tag Only) »** terminé sur GitHub.

* **GitHub Releases :** la release `v0.0.x` est créée avec le changelog auto-généré.
* **Docker Hub :** le tag `spadmdck/klaro:0.0.x` est présent. *(Le tag `latest` est aussi mis à jour.)*

### Cluster K3s

```bash
# Vérifier que le déploiement utilise la nouvelle version
kubectl describe deployment klaro -n apps | grep Image

# Résultat attendu : spadmdck/klaro:0.0.x
```

---

## 6. ⚠️ Dépannage

| Symptôme                               | Cause probable                                                       | Solution                                                              |
| -------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Le pipeline ne démarre pas             | Push sans tag.                                                       | Vérifier que `git push --tags` a bien été fait.                       |
| Job Build échoue : “Tag mismatch”      | Le tag Git (`v1.0.1`) ne correspond pas au `package.json` (`1.0.0`). | Corriger `package.json`, refaire un commit, supprimer/recréer le tag. |
| Erreur SQLite “Binary was compiled...” | Problème de driver CGO.                                              | Vérifier que `go.mod` utilise `github.com/glebarez/sqlite`.           |
| Docker Push “Denied”                   | Secrets manquants.                                                   | Vérifier les secrets `DOCKER_*` dans l’Organisation GitHub.           |

---

## 7. 🔐 Gestion des Secrets & Infra

* **Organisation :** `saasMsDGH`
* **Portée des secrets :** Organisation (accessibles à tous les futurs projets SaaS)
* **Runner :** Self-Hosted dans le cluster K3s (Namespace `actions-runner-system`)
