# Module Notes

Une fiche de notes par conversation Snapchat Web, dans une fenêtre séparée. Tout reste sur l'ordinateur
(`chrome.storage.local`) : pas de serveur, de compte ni de synchronisation, et aucune note n'est transmise.

## Utilisation
1. Popup → **Notes** → activer **Activer Notes** (désactivé par défaut), puis **Ouvrir Notes** (fenêtre
   flottante). Notes s'ouvre aussi directement dans un onglet : `chrome-extension://<id>/notes.html`
   (identifiant affiché dans `chrome://extensions`), à mettre en favori par exemple. Fenêtre et onglets
   montrent les mêmes fiches ; une modification faite dans l'un apparaît dans les autres.
2. Ouvrir une conversation sur `https://www.snapchat.com/web/…` : sa fiche (vide) est créée et
   sélectionnée. Le suivi continue fenêtre fermée, tant que le module est activé.
3. Écrire : titres, gras, italique, souligné, listes, liens (http, https, mailto ; pas d'images).
   Sauvegarde automatique 300 ms après la dernière frappe ; l'état est affiché (*Modification en cours…*,
   *Sauvegarde…*, *Sauvegardé*, *Erreur de sauvegarde* avec **Réessayer**).

**Dernière conversation** : la dernière conversation détectée (UUID de l'URL, nom, onglet source) est
mémorisée dans le stockage et reste la conversation active jusqu'à ce qu'une autre conversation valide
soit détectée, même si Snapchat la masque ensuite (fenêtre quittée, popup ouvert), si l'onglet est fermé
ou si le service worker redémarre. Notes s'ouvre donc sur sa fiche, prête à l'édition ; sans conversation
détectée, un message l'indique.

**Fenêtre** : une seule ; « Ouvrir Notes » la remet au premier plan (et la restaure si elle est réduite).
Position et taille sont reprises à la réouverture, y compris sur un autre écran (taille par défaut si cet
écran n'est plus branché). La fermer ne désactive rien.

**Suivi** : la fiche affichée suit la conversation ouverte sur Snapchat, sauf
- pendant l'édition (focus dans l'éditeur ou sa barre d'outils) : le dernier changement est appliqué
  quand le focus en sort ;
- après un choix manuel dans la liste : suivi suspendu jusqu'à **Reprendre le suivi**.

**Liste** : recherche par nom de conversation (jamais dans le contenu), tri par activité récente
(dernière ouverture sur Snapchat ou dernière modification), réorganisation par glisser-déposer ou
`Alt+↑`/`Alt+↓` (ordre conservé), **Trier par activité récente** pour revenir au tri par défaut.
Le nom suit Snapchat ; il ne se modifie pas à la main, et une fiche ne se crée pas à la main.

**Corbeille** : **Supprimer** y envoie la fiche, sans limite de durée. **Restaurer** ou **Supprimer
définitivement** (confirmé). Une conversation de la corbeille rouverte sur Snapchat n'est ni restaurée
ni dupliquée : un bandeau propose **Restaurer la fiche**.

**Export** : la fiche ouverte en HTML (page autonome, lisible dans un navigateur) ou TXT. **Exporter
tout (ZIP)** : `manifest.json`, `html/*.html`, `txt/*.txt` ; corbeille exclue sauf **Inclure la
corbeille**.

**Import** : **Importer une archive** (ZIP exporté par LeakZero). L'archive est entièrement vérifiée et
son contenu affiché avant toute écriture. En cas de conflit (même fiche ou même conversation) :
**Conserver l'existante** (par défaut), **Remplacer** (garde l'identifiant et la conversation de la
fiche existante) ou **Conserver les deux** (copie « (copie importée) », nouvel identifiant, détachée de
la conversation si une autre fiche la suit déjà). Choix global, modifiable fiche par fiche.

**Désactiver le module** ferme la fenêtre et arrête le suivi ; aucune donnée n'est supprimée.

## Architecture

| Fichier | Rôle | Contexte |
| --- | --- | --- |
| `src/modules/notes/module.yaml`, `components/OpenNotesButton.tsx` | déclaration, bouton du popup | popup |
| `src/content/notes.ts`, `src/notes/detect.ts` | détection de la conversation | Snapchat Web |
| `src/notes/background.ts` | commandes, autorisation, fermeture à la désactivation | service worker |
| `src/notes/store.ts`, `importing.ts` | écritures des fiches (seul écrivain) | service worker |
| `notes.html` | page Notes (fenêtre flottante ou onglet) | page |
| `src/notes/window.ts` | fenêtre unique, position et taille | popup, service worker, page |
| `src/notes/model.ts`, `keys.ts` | schéma (Zod) et clés de stockage | tous |
| `src/notes/page/` (`NotesApp`, `NoteList`, `TrashList`, `NoteEditor`, `ArchiveActions`) | fenêtre Notes | page |
| `src/notes/follow.ts`, `list.ts`, `autosave.ts` | suivi, tri, sauvegarde différée (fonctions pures) | page |
| `src/notes/content.ts`, `archive.ts` | schéma de l'éditeur (Tiptap), export, import | page |

**Communication.** Comme les réglages, l'état est dans `chrome.storage.local`, lu par chaque contexte et
suivi par `storage.onChanged`. Les écritures passent par des commandes `chrome.runtime.sendMessage`
(`notes:*`, `src/notes/messages.ts`) au service worker, qui les exécute une à une, chacune en un seul
`storage.local.set` atomique : deux onglets Snapchat et la fenêtre ne peuvent pas s'écraser. Rien
n'est gardé en mémoire : le service worker peut s'arrêter entre deux commandes, ses écouteurs sont
enregistrés au démarrage. Le popup ouvre la fenêtre lui-même (`chrome.windows`), sans passer par le
service worker ; elle est retrouvée par `runtime.getContexts` (Chrome 116+) parmi les fenêtres de type
`popup`, un onglet Notes n'étant pas la fenêtre flottante. Seule cette dernière mémorise sa position.
Le script de protection (`src/content/index.ts`) ne communique toujours rien.

**Autorisation.** Le service worker n'accepte des pages web que `notes:conversation`, et seulement
depuis `https://www.snapchat.com` ; toutes les autres commandes doivent venir d'une page de l'extension.
Chaque commande est validée (Zod) avant exécution.

**Stockage.** `notes:note:<id>` (une clé par fiche), `notes:order` (ordre manuel, absent = tri récent),
`notes:active` (dernière conversation détectée), `notes:window` (position et taille, écrite par la page).
L'identifiant d'une fiche est généré par LeakZero (`crypto.randomUUID`) ; `conversationId` est celui de
Snapchat. Une conversation a au plus une fiche. Les mises à jour de l'extension ne touchent pas ces clés.

**Détection.** L'identifiant vient uniquement de l'URL `/web/<uuid>` : sans UUID, aucune fiche n'est
créée (jamais de clé par nom, donc deux conversations homonymes restent distinctes). Le nom vient de
l'en-tête de la conversation (`main header h1–h3`) ou, à défaut, du titre de la page ; s'il est
introuvable, la fiche s'appelle « Conversation <8 premiers caractères> » et prend le vrai nom dès qu'il
apparaît, et un nom connu n'est jamais effacé. Messages, médias et liste des conversations ne sont
jamais lus. Un seul `MutationObserver`, regroupé toutes les 250 ms, n'envoie qu'en cas de changement ;
il est déconnecté quand le module est désactivé et s'arrête si le script devient orphelin (mise à jour).

**Contenu.** Le schéma Tiptap (`src/notes/content.ts`) sert aussi de filtre : le HTML importé est
analysé par `DOMParser` (aucune exécution) puis réduit au schéma, ce qui retire scripts, attributs,
styles, images, cadres et liens non http/https/mailto. Les exports HTML repassent par ce filtre et
portent une CSP `default-src 'none'`.

**Sauvegarde.** 300 ms après la dernière modification, immédiate au changement de fiche, à l'export et
à `pagehide` (fermeture). Un échec garde le contenu et l'indique ; la sauvegarde suivante le reprend.
Limites : 1 Mo de HTML par fiche ; `chrome.storage.local` est limité à 10 Mo au total.

## Limites connues
- Les sélecteurs du nom dépendent du DOM de Snapchat Web : s'il change, les fiches gardent leur dernier
  nom connu (ou le nom provisoire) jusqu'à adaptation de `HEADER_NAME` dans `src/notes/detect.ts`.
- Le script n'est injecté qu'au chargement d'une page `www.snapchat.com/web*` ; arriver sur Snapchat Web
  par une navigation interne depuis une autre page de snapchat.com nécessite de recharger l'onglet.
- Avec plusieurs onglets Snapchat, la conversation active est celle de l'onglet affiché en dernier.
- « Le service d'arrière-plan de LeakZero ne répond pas » : aucun service worker à jour n'écoute (son
  démarrage a échoué, ou il exécute encore une ancienne version après un rebuild). Recharger LeakZero
  dans `chrome://extensions` et consulter ses « Erreurs ». La sauvegarde reprend avec **Réessayer**.
- Désactiver le module ferme la fenêtre flottante, pas un onglet Notes ouvert à la main.
- Une fermeture brutale du navigateur dans les 300 ms qui suivent une frappe peut perdre cette frappe.
