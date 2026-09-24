# Plan d'action — améliorations (esthétique, gameplay, performance)

Issu du bilan du projet par rapport à la fiche (`fiche-projet-backrooms-vr.md`). Ordre choisi :
**mesurer d'abord**, alléger le rendu (sinon chaque ajout visuel aggrave le risque Quest),
puis l'esthétique, puis le gameplay. Chaque phase = un commit sur `main`.

## Phase 0 — Mesure
| # | Action | Détail |
|---|---|---|
| 0.1 | Compteur de perfs | `?debug=1` : FPS, draw calls, triangles, textures/géométries en mémoire, affichés dans le HUD caméscope (lisible en casque). |

## Phase 1 — Performance
| # | Action | Détail |
|---|---|---|
| 1.1 | Sol/plafond uniques | Un seul plan sol + un seul plan plafond qui suivent le joueur (calés sur la grille des chunks, UV alignées sur les cellules) au lieu de 2 draw calls par chunk : **~50 draw calls en moins**. |
| 1.2 | Relief sol/plafond | Plus de displacement sur sol/plafond (invisible) ; subdivision réduite à 1 quad/cellule (suffisant pour le tremblement des glitchs). |
| 1.3 | Champ de lumière par sommet | `vhsZoneLight` calculé dans le vertex shader (varying) au lieu de chaque pixel ; seul le plafond garde un test par cellule. Zones de glitch lointaines (>16 m) non envoyées au shader. |
| 1.4 | Textures | Suppression des cartes inutiles (AO/displacement sol-plafond), roughness en 512 px ; KTX2 si un encodeur est disponible dans l'environnement, sinon à faire hors-ligne (documenté). |
| 1.5 | Bundle | Découpage en chunks vendeurs (three, rapier) pour le cache navigateur ; compression vérifiée côté serveur. |
| 1.6 | Audio | Pré-génération étalée (une petite tâche par frame) de tous les buffers au démarrage de la session XR : plus d'à-coup au premier son. |
| 1.7 | Réglages XR | `setPixelRatio` limité au mode écran, `setFoveation(1)`, `framebufferScaleFactor` explicite. |

## Phase 2 — Esthétique
| # | Action | Détail |
|---|---|---|
| 2.1 | Glitchs VHS | Bandes déchirées, traînées de tête de lecture, dropouts fins, rares blocs arrachés — plus de damier RGB. Vérification en capture. |
| 2.2 | Décrépitude par profondeur | Uniforme `uDecay` : taches d'humidité qui remontent des plinthes, moquette auréolée, dalles de plafond manquantes (trou noir, néon mort), teinte qui dérive du jaune vers un vert malade puis un gris froid. |
| 2.3 | Glitchs d'événement | Écran bleu VHS « ▶ PLAY » bref au changement de niveau, perte de signal complète (neige) à la téléportation et, rarement, à forte corruption. Tête fixe, pas de mouvement d'image (confort). |
| 2.4 | Sortie | Porte banale entrouverte, noir total derrière, l'entrebâillement grésille. Fini le portail cyan. |
| 2.5 | Objets qui bougent | Poltergeist : hors du champ de vision, une chaise glisse ou bascule, avec raclement positionnel ; rarement, un objet lointain bouge dans le champ. |

## Phase 3 — Gameplay
| # | Action | Détail |
|---|---|---|
| 3.1 | Boucle spatiale | Nouveau piège : renvoie le joueur là où il était ~10 s plus tôt (historique de positions), jamais plus près de la sortie. |
| 3.2 | Batterie de lampe | La lampe consomme (HUD `BAT` = lampe), faiblit et clignote sous 20 %, s'éteint à 0. Piles à trouver au sol (plus fréquentes en profondeur), ramassées à la main. |
| 3.3 | Collection utile | Bonus passifs selon la collection (capacité de batterie, dissipation de la corruption) ; série « bandes perdues » : un récit en fragments numérotés qui se suit d'une run à l'autre. |
| 3.4 | Labyrinthe visible | Régénération occasionnelle d'un chunk voisin **derrière** le joueur (hors champ, jamais sur lui) pour qu'il le remarque en se retournant. |
| 3.5 | Balise brouillée | À forte corruption, la balise de sortie décroche, se désaccorde, et un faux écho joue d'une mauvaise direction. |
| 3.6 | i18n | `fr.json` / `en.json`, langue du navigateur + bascule dans les options ; HUD, menus, écran de fin, lore. |

## Suivi
| Phase | État | Commit |
|---|---|---|
| 0 — Mesure | ✅ | `d7b0be6` |
| 1 — Performance | ✅ (sauf mesures casque) | `d7b0be6` |
| 2 — Esthétique | ✅ | `291735d` |
| 3 — Gameplay | ✅ | commit « Gameplay … (phase 3) » |

Mesures (Chromium/SwiftShader, vue ouverte au spawn, niveau 0) : **110 → 25 draw calls**,
**627k → 147k triangles** après la phase 1. Écarts avec le plan :
- 1.4 : toutes les cartes restent en 1K mais passent en KTX2 (UASTC pour couleur/normales,
  ETC1S pour AO+roughness empaquetées) — l'ETC1S abîmait trop le papier peint. Téléchargement
  des textures : 2,0 Mo (WebP) → 5,4 Mo, mémoire GPU ~4× plus faible.
- 1.1 : les meubles restent un objet physique chacun ; ils sont fusionnés par matériau et
  masqués au-delà de 17 m (c'étaient eux, plus que les chunks, qui coûtaient des draw calls).

Session XR émulée (runtime `iwer` Meta Quest 3, Chromium/SwiftShader) : la session démarre
sans erreur, rendu fovéal actif, franchir la porte fait bien descendre d'un niveau (écran
bleu). Draw calls **en stéréo** (les deux yeux) au spawn : 76 → 70 après masquage des chunks
au-delà de 34 m ; ~130 face à la sortie. Le multiview (deux yeux en une passe) n'existe dans
three.js que pour le moteur WebGPU : y passer demanderait de réécrire les shaders VHS en TSL —
à envisager seulement si les mesures en casque l'exigent.

À faire en casque : FPS moyen et draw calls au niveau 0 et au niveau 5 avec `?debug=1`,
à reporter ici ; ajuster `RENDER_DISTANCE` (grabbable.ts) et la densité des zones sombres
(`lightField.ts`) selon le ressenti.
