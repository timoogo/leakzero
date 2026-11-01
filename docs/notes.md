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

**Liste** : recherche par titre personnalisé ou nom de conversation (jamais dans le contenu), tri par activité récente
(dernière ouverture sur Snapchat ou dernière modification), réorganisation par glisser-déposer ou
`Alt+↑`/`Alt+↓` (ordre conservé), **Trier par activité récente** pour revenir au tri par défaut.
Une fiche ne se crée pas à la main.

**Renommer** : le crayon à côté du titre donne à la fiche un titre personnalisé (Entrée valide, Échap
annule), affiché à la place du nom Snapchat dans la liste, la fenêtre, la recherche et les exports. Le
nom Snapchat continue d'être suivi en dessous (« Nom Snapchat : … ») sans jamais remplacer le titre
personnalisé ; **Revenir au nom Snapchat** (ou un titre vide) le retire. L'UUID de la conversation ne
change jamais.

**Actualiser le nom Snapchat** (à côté de « Nom Snapchat », ou du titre sans titre personnalisé) : demande
le nom affiché maintenant à l'onglet Snapchat Web ouvert sur cette conversation (URL `/web/<uuid>`). Seul
l'onglet qui affiche réellement ce UUID répond, donc deux conversations homonymes ne sont jamais
confondues. Sans onglet, sans réponse de LeakZero dans l'onglet ou sans nom affiché, un message
l'explique et le nom actuel est conservé. Le nom suit aussi Snapchat automatiquement (observation du DOM,
sans polling) ; un nom masqué ou provisoire ne remplace jamais un nom valide.

**Corbeille** : **Supprimer** y envoie la fiche, sans limite de durée. **Restaurer** ou **Supprimer
définitivement** (confirmé). Une conversation de la corbeille rouverte sur Snapchat n'est ni restaurée
ni dupliquée : un bandeau propose **Restaurer la fiche**.

**Export** : la fiche ouverte en HTML (page autonome, lisible dans un navigateur) ou TXT. **Exporter
tout (ZIP)** : `manifest.json`, `html/*.html`, `txt/*.txt` ; corbeille exclue sauf **Inclure la
corbeille**. Chaque fichier d'une fiche de conversation se termine par ses **Messages sélectionnés**
(les mêmes informations que la section de la fiche, échappées en HTML), et seulement ceux de sa
conversation. Images : HTML seul, aperçus intégrés (`data:`) ; ZIP, fichiers `media/…` liés par chemin
relatif ; une image spoiler est dans un `<details>` fermé, révélée sans script ; une image sans aperçu
est seulement nommée (« Image indisponible hors ligne »). La CSP des pages n'autorise que ces sources
d'images, jamais une URL distante. TXT : `[Image]`, `[Image — spoiler]` ou `[Image indisponible]`. Chaque
export est daté d'un seul instant : « exportée le … » en HTML (`<time datetime>`) et en TXT,
`exportedAt` (ISO 8601) dans `manifest.json`. Les messages sont lus dans
IndexedDB au moment de l'export (`notes:selectedMessages`) : si la lecture échoue, l'export est annulé
avec un message d'erreur plutôt que produit sans eux. Ils sont hors de `<main id="note">` et ne sont
donc jamais réimportés dans le texte d'une fiche.

**Import** : **Importer une archive** (ZIP exporté par LeakZero). L'archive est entièrement vérifiée et
son contenu affiché avant toute écriture. En cas de conflit (même fiche ou même conversation) :
**Conserver l'existante** (par défaut), **Remplacer** (garde l'identifiant et la conversation de la
fiche existante) ou **Conserver les deux** (copie « (copie importée) », nouvel identifiant, détachée de
la conversation si une autre fiche la suit déjà). Choix global, modifiable fiche par fiche.

**Sélectionner des messages** (en-tête de la fiche d'une conversation, dans Notes) : le mode s'active pour
cette conversation seulement. De retour sur Snapchat Web, chaque message de cette conversation reçoit une case à
cocher (cochée = sélectionné). Un clic sur la case ou sur le message le sélectionne, un second le
désélectionne ; les messages sélectionnés sont aussi entourés d'un liseré bleu. Un badge en bas à
gauche rappelle que le mode est actif ; **Terminer** (badge) ou **Terminer la sélection** (fiche) l'arrête,
sans rien effacer. Les cases restent tant que le mode est actif, Notes et popup fermés ; une autre
conversation ouverte sur Snapchat n'en a pas. En
mode, le clic sur un message est pris par LeakZero (Snapchat n'ouvre pas le média) ; les clics ailleurs
(liste latérale, en-têtes, saisie) restent à Snapchat. Mode arrêté : aucun écouteur, aucune marque. Les
sélections sont propres à chaque conversation (UUID de l'URL) et reviennent après rechargement de
Snapchat ou redémarrage du navigateur.

**Messages sélectionnés** (section sous l'éditeur de la fiche d'une conversation) : les messages cochés de
cette conversation, avec leur nombre, dans l'ordre de sélection. Pour chacun, ce que Snapchat affichait :
auteur, date d'envoi (`datetime`, sinon l'heure affichée), type, texte, médias (nature et texte
alternatif) et liens, plus la date de sélection ; une information absente n'est pas affichée. La section
se met à jour dès qu'un message est coché ou décoché sur Snapchat, sans recharger Notes.

**Images.** Au moment où un message est sélectionné, le script Snapchat copie chacune de ses images telle
que la page l'a déjà chargée et décodée (canvas, JPEG réduit à 480 px au plus) : aucune requête, aucun
média Snapchat téléchargé. Si l'image n'est pas encore chargée ou que le navigateur en interdit la
lecture (image d'une autre origine), elle est enregistrée sans aperçu et affichée « Image indisponible ».
Dans la fiche, chaque image est à droite de son message, avec un
interrupteur **Spoiler** enregistré dans IndexedDB (`notes:setSpoiler`, par image). Une image spoiler est
masquée par un bloc « Image masquée — spoiler » ; **Afficher l'image** la révèle sur cet écran seulement,
jusqu'à **Masquer l'image** ou la réouverture de la page. Les enregistrements antérieurs se lisent sans
aperçu et sans spoiler.

**Vidéos.** Au moment où un message est sélectionné, le script Snapchat lit l'adresse `blob:` que le
lecteur de Snapchat tient déjà pour chacune de ses vidéos (`<video src>` ou `<source>`, de l'origine de la
page uniquement) : `fetch(blob:)` la lit en mémoire, sans requête réseau. Une adresse distante (`https:`)
n'est jamais demandée. Le fichier doit être une vidéo par ses octets (MP4/QuickTime `ftyp` hors marques
d'image HEIC/AVIF, WebM), 32 Mio au plus (`MAX_VIDEO_BYTES`, `src/notes/video.ts`). Il est envoyé au
service worker (`notes:storeVideo`), qui le vérifie à nouveau et l'enregistre tel quel, sans transcodage.
La sélection est enregistrée d'abord : une vidéo qui ne peut pas être capturée (adresse expirée, flux
MediaSource, fichier trop gros, disque plein) est signalée dans la console de l'onglet (raison seule,
jamais l'adresse ni le contenu) et le message reste sélectionné sans elle. Les vidéos stockées ne sont
pas encore affichées ni exportées.

**Visionneuse.** Un clic sur une miniature (ou une vignette vidéo) ouvre un dialogue modal au-dessus de la
fiche : le média en grand, proportions conservées, ajusté à la fenêtre ; « 2 / 3 », boutons et flèches
gauche/droite pour passer d'un média du message à l'autre (images copiées et vidéos ; une image sans
aperçu n'a rien à montrer) ; Échap ou **Fermer** rend le focus à la miniature. Une image spoiler y reste
masquée jusqu'à **Afficher l'image**, à chaque ouverture, sans changer son statut enregistré. La
visionneuse ne lit pas les vidéos stockées : une vidéo y est seulement décrite (ou son aperçu montré s'il
existe). Le lecteur HTML5 (contrôles natifs) ne sert qu'à un fichier vidéo local. Elle ne fait pas
partie du texte de la fiche ; elle figure dans ses exports (voir **Export**).

**Désactiver le module** ferme la fenêtre et arrête le suivi et la sélection ; aucune donnée n'est supprimée.

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
| `src/notes/selection.ts` | mode sélection : lecture des messages, clics, liserés, badge | Snapchat Web |
| `src/notes/selections.ts` | messages sélectionnés (IndexedDB, seul écrivain) | service worker |
| `src/notes/video.ts` | capture des vidéos (`blob:` de la page), vérification des octets | Snapchat Web, service worker |
| `src/notes/page/SelectedMessages.tsx` | section « Messages sélectionnés » de la fiche | page |

**Communication.** Comme les réglages, l'état est dans `chrome.storage.local`, lu par chaque contexte et
suivi par `storage.onChanged`. Les écritures passent par des commandes `chrome.runtime.sendMessage`
(`notes:*`, `src/notes/messages.ts`) au service worker, qui les exécute une à une, chacune en un seul
`storage.local.set` atomique : deux onglets Snapchat et la fenêtre ne peuvent pas s'écraser. Rien
n'est gardé en mémoire : le service worker peut s'arrêter entre deux commandes, ses écouteurs sont
enregistrés au démarrage. Le popup ouvre la fenêtre lui-même (`chrome.windows`), sans passer par le
service worker ; elle est retrouvée par `runtime.getContexts` (Chrome 116+) parmi les fenêtres de type
`popup`, un onglet Notes n'étant pas la fenêtre flottante. Seule cette dernière mémorise sa position.
Le script de protection (`src/content/index.ts`) ne communique toujours rien.

**Autorisation.** Le service worker n'accepte des pages web que `notes:conversation`, `notes:select`,
`notes:unselect` et `notes:selectedKeys`, et seulement depuis `https://www.snapchat.com` ; les trois
dernières seulement pour la conversation affichée par l'onglet qui les envoie (`/web/<uuid>`). Toutes les
autres commandes doivent venir d'une page de l'extension, dont `notes:selectedMessages` (messages
sélectionnés d'une conversation, pour sa fiche).
Chaque commande est validée (Zod) avant exécution.

**Stockage.** `notes:note:<id>` (une clé par fiche), `notes:order` (ordre manuel, absent = tri récent),
`notes:active` (dernière conversation détectée), `notes:window` (position et taille, écrite par la page).
Une fiche porte `name` (nom détecté, suit Snapchat) et `customName` (titre personnalisé ou `null`,
absent des fiches et archives antérieures) ; seule une page de l'extension peut le modifier
(`notes:rename`). L'identifiant d'une fiche est généré par LeakZero (`crypto.randomUUID`) ; `conversationId` est celui de
Snapchat. Une conversation a au plus une fiche. Les mises à jour de l'extension ne touchent pas ces clés.
`notes:selecting` : UUID de la conversation en cours de sélection, ou `null` (écrit par la fiche et le badge).
`notes:selectionChanged` : `{ conversationId, at }`, écrit par le service worker après chaque sélection ou
désélection (IndexedDB n'a pas d'événement de changement) ; la page Notes relit alors les messages de
cette conversation. Ne contient aucun message.

**Messages sélectionnés.** Base IndexedDB `leakzero-notes` de l'extension (origine `chrome-extension://`,
illisible par Snapchat), magasin `selectedMessages`, clé `[conversationId, key]`, non chiffrée. Chaque
enregistrement garde ce que Snapchat affiche, sans rien deviner : `text` (texte visible, sans en-tête ni
heure), `author` (dernier `<header>` du groupe), `sentAt` (attribut `datetime` du `<time>` du message) et
`timeLabel` (son texte), `type` (`text`, `image`, `video`, `media`, `unknown`), `media` (nature et `alt`,
avatars Bitmoji exclus, jamais le contenu), `links` (http, https, mailto) et `selectedAt`. Absent de la
page : `null` ou vide. Re-sélectionner un message garde son premier enregistrement.

**Vidéos stockées.** Même base, depuis sa version 2 (la mise à niveau garde les sélections) : magasin
`videos`, clé SHA-256 du fichier, `{ sha256, bytes (ArrayBuffer, octets d'origine), mime, size, storedAt }` ;
magasin `videoRefs`, clé `[conversationId, key, media]` (index du média dans le message), `{ sha256, width,
height, duration, capturedAt }` (`null` quand le lecteur ne les connaissait pas). Un même fichier n'est
stocké qu'une fois, quel que soit le nombre de sélections ou de messages qui le référencent. Le service
worker n'accepte une vidéo que d'un onglet affichant sa conversation, pour un message encore sélectionné
dont ce média est une vidéo. Désélectionner un message supprime ses références, et chaque fichier qui n'est
plus référencé, dans la même transaction. Le transport est en base64 (la messagerie de Chrome n'accepte
que du JSON) ; le stockage est binaire.

**Détection.** L'identifiant vient uniquement de l'URL `/web/<uuid>` : sans UUID, aucune fiche n'est
créée (jamais de clé par nom, donc deux conversations homonymes restent distinctes). Le nom vient de
l'en-tête de la conversation, repéré uniquement par des ancres sémantiques, jamais par les classes ou
`id` générés de Snapchat : le texte de l'unique contrôle `[aria-haspopup="listbox"]` du plus petit
conteneur autour de `button[title="Close Chat"]` (`conversationHeaderName`). Plusieurs « Close Chat »,
plusieurs contrôles dans l'en-tête ou un contrôle de la liste latérale donnent « pas de nom » plutôt
qu'un mauvais nom, et un en-tête encore affiché pour la conversation précédente (URL changée avant lui)
ne nomme pas la nouvelle. À défaut, le nom vient du titre de la page ; s'il est
introuvable, la fiche s'appelle « Conversation <8 premiers caractères> » et prend le vrai nom dès qu'il
apparaît, et un nom connu n'est jamais effacé. Messages, médias et liste des conversations ne sont
jamais lus. Un seul `MutationObserver`, regroupé toutes les 250 ms, n'envoie qu'en cas de changement ;
il est déconnecté quand le module est désactivé et s'arrête si le script devient orphelin (mise à jour).
Exception, en mode sélection uniquement : les messages de la conversation ouverte sont lus (second
`MutationObserver`, même regroupement) pour les marquer, et un message n'est envoyé au service worker
qu'au clic qui le sélectionne. Rien ne sort de l'ordinateur.

**Identité d'un message.** Snapchat Web n'expose aucun identifiant de message : la clé est une empreinte
(auteur, `datetime`, lettres et émojis du texte, médias, liens) suivie du rang parmi les messages
identiques de la conversation affichée (`<empreinte>:<rang>`). Les chiffres n'y entrent pas, car la
protection des numéros les réécrit dans la page (`**********`) : l'activer ou la désactiver ne change pas
la clé. Le chat est le plus petit conteneur de l'unique `Close Chat` contenant un message candidat (les listes de
menus et d'options, `role="listbox"`, `menu`…, ne comptent pas : Downshift laisse en permanence son
`<ul role="listbox">` dans l'en-tête, qui passait sinon pour le chat, sans aucun message) ; un message, un
élément de liste (`li`, `[role="listitem"]`) le plus interne de ce chat, hors navigation. Aucune classe
générée n'est utilisée. Les marques sont des attributs `data-leakzero-selected`/`-selectable` posés sur
ces éléments et retirés à l'arrêt du mode. Les cases (`input[type="checkbox"]` avec `aria-label` : expéditeur
et début du texte) sont dans une couche fixe `<leakzero-selection>` ajoutée à `<html>`, hors de `<body>`
(shadow root ouvert, avec le badge) : rien n'est inséré dans les messages et leur mise en page ne change
pas. Les cases forment une colonne de sélection : une bande verticale à position fixe, indépendante de la
largeur des bulles, où aucun message affiché ne peint rien (lignes de texte, médias, avatar, heure). Dans
la marge gauche de la liste visible, sinon sa marge droite, sinon juste à l'extérieur de la liste, à
gauche ou à droite, si la conversation laisse la place ; la colonne en cours est gardée tant qu'elle
reste libre. Chaque case est centrée sur la première ligne de son message (ou le haut de son premier
média), recalculée à chaque frame pour suivre le défilement, et masquée quand son message sort de la
zone visible de la liste. Si aucune colonne n'est libre, les cases sont masquées plutôt que posées sur
les messages, et c'est signalé : avertissement `[LeakZero Sélection] aucune colonne libre…` dans la
console (toujours) et `noColumn: true` dans le diagnostic. Le clic sur un message reste disponible. Les événements de la couche ne remontent pas à Snapchat.

**Contenu.** Le schéma Tiptap (`src/notes/content.ts`) sert aussi de filtre : le HTML importé est
analysé par `DOMParser` (aucune exécution) puis réduit au schéma, ce qui retire scripts, attributs,
styles, images, cadres et liens non http/https/mailto. Les exports HTML repassent par ce filtre et
portent une CSP `default-src 'none'`.

**Sauvegarde.** 300 ms après la dernière modification, immédiate au changement de fiche, à l'export et
à `pagehide` (fermeture). Un échec garde le contenu et l'indique ; la sauvegarde suivante le reprend.
Limites : 1 Mo de HTML par fiche ; `chrome.storage.local` est limité à 10 Mo au total.

## Limites connues
- Le nom dépend de ces ancres de Snapchat Web (`CLOSE_CHAT`, `NAME_CONTROL` dans `src/notes/detect.ts`) :
  si elles changent, les fiches gardent leur dernier nom connu (ou le nom provisoire).
- Le script est injecté sur toutes les pages `snapchat.com` et `www.snapchat.com` (Snapchat Web peut être
  atteint sans rechargement) mais n'agit que sur `/web/<uuid>`.
- Diagnostic (temporaire) : la console de l'onglet Snapchat affiche les étapes `[LeakZero Notes]`
  (script chargé, module activé, URL sans conversation, conversation détectée avec ou sans nom, envoi
  enregistré ou échoué avec sa raison, nouvel essai toutes les 2 s). Aucune ligne : script non injecté.
  La console du service worker (`chrome://extensions` → LeakZero → « service worker ») affiche les
  conversations enregistrées ou refusées.
- Avec plusieurs onglets Snapchat, la conversation active est celle de l'onglet affiché en dernier.
- « Le service d'arrière-plan de LeakZero ne répond pas » : aucun service worker à jour n'écoute (son
  démarrage a échoué, ou il exécute encore une ancienne version après un rebuild). Recharger LeakZero
  dans `chrome://extensions` et consulter ses « Erreurs ». La sauvegarde reprend avec **Réessayer**.
- Désactiver le module ferme la fenêtre flottante, pas un onglet Notes ouvert à la main.
- Une fermeture brutale du navigateur dans les 300 ms qui suivent une frappe peut perdre cette frappe.
- Sélection : la structure des messages (`li`, `<header>` d'expéditeur, `<time>`) n'a été vérifiée que
  sur des reproductions, pas sur le DOM réel de Snapchat Web ; si elle diffère, auteur ou date restent
  `null`, ou aucun message n'est sélectionnable. Le rang distingue les messages identiques (« ok »)
  d'après ceux affichés : si Snapchat charge des messages plus anciens identiques, le rang peut glisser et
  la marque passer à un voisin identique. Un message modifié ou supprimé sur Snapchat n'est plus
  reconnu (son enregistrement reste). Le texte enregistré est celui de la page : chiffres masqués si la
  protection des numéros est active. Seuls `click`/`dblclick` sont interceptés : une action de Snapchat
  déclenchée à l'appui (`pointerdown`) passerait encore. Le badge et les liserés sont visibles à l'écran,
  donc en livestream.
- Diagnostic de la sélection : dans la console de l'onglet Snapchat, `localStorage.setItem('leakzero:debug', '1')`
  (toujours actif avec `pnpm dev`) affiche à chaque changement des lignes `[LeakZero Sélection] {…}` :
  module activé, conversation visée et affichée (8 premiers caractères), nombre de « Close Chat », chat
  trouvé, éléments de liste, messages détectés, chargement de la sélection, couche montée, cases créées,
  colonne utilisée (`column`) ou absence de colonne libre (`noColumn`), cases placées (`placed`) et réellement visibles (`visible` : à l'écran et
  élément le plus haut en leur centre, mesuré sur les cases elles-mêmes ; rafraîchi aussi pendant le
  défilement, au plus deux fois par seconde). Jamais le contenu d'un message. `localStorage.removeItem('leakzero:debug')` l'arrête.
- Colonne de sélection : vérifiée seulement sur géométrie simulée. Si un message affiché touche les deux
  marges de la liste et que la conversation n'a pas de place autour, aucune colonne n'est libre (signalé,
  voir plus haut). Deux messages de moins de 18 px de haut, collés, peuvent avoir des cases qui se touchent.
- Vidéos : l'adresse `blob:` n'existe que tant que la page la garde ; après un rechargement, une fermeture
  ou le recyclage du lecteur par Snapchat, elle est révoquée et la vidéo n'est plus capturable (resélection
  sans effet tant que le lecteur n'a pas rechargé la vidéo). Une vidéo jouée par MediaSource (adresse
  `blob:` d'un flux, pas d'un fichier) n'est pas lisible. Seule une vidéo dont l'élément `<video>` est dans
  le message au moment de la sélection est capturée : si Snapchat ne crée le lecteur qu'à l'ouverture,
  ouvrir la vidéo puis sélectionner le message. Le codec n'est pas vérifié : une vidéo HEVC (`hvc1`) est
  stockée telle quelle même si Chrome (Linux) ne sait pas la lire ; `width`, `height` et `duration` sont
  alors souvent `null`. Une fiche supprimée définitivement garde ses messages sélectionnés et leurs vidéos
  (comme avant ce lot).
- Les messages sélectionnés s'affichent en clair dans Notes, y compris les numéros de téléphone qu'ils
  contenaient s'ils n'étaient pas masqués sur Snapchat au moment de la sélection : la protection des
  numéros ne s'applique pas aux pages de l'extension.
