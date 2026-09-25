# Generation prompts · Siamese Midi

Tool: Codex built-in image_gen (run through `generate.sh`). Reference role: the seal-point Siamese photograph supplied on 2026-09-15 is the identity reference only, never an edit target.

## Shared identity block

```text
Use case: stylized-concept. Asset type: pixel-art pet character and action design sheet for a desktop typing companion called Midi. The attached cat photograph is the sole identity reference, not a target to reproduce photographically. Faithfully preserve the real cat: stocky sturdy adult seal-point Siamese of the traditional apple-head build (NOT a slender modern wedge-faced show Siamese), broad rounded head, large dark seal-brown ears with pale inner fur, dark seal-brown face mask covering both eyes, nose bridge, muzzle and chin, a lighter fawn band between the mask and the ears, striking pale ice-blue eyes with dark pupils, black nose, warm fawn-cream body with a bright cream-white chest bib, slightly darker warm brown shading on the back and flanks, dark seal-brown legs and paws so the feet read almost black, thick dark seal-brown tail. NOT a tabby, NO stripes, NO rings, NOT gray or silver, NOT orange, NOT a kitten. Strict deliberate square-pixel clusters with crisp stair-step edges, limited palette (near-black seal brown, dark chocolate brown, warm mid brown, fawn beige, cream, ivory white, muted pink, pale ice blue). No gradients, soft brushes, anti-aliased illustration, fur noise, glow, 3D, accessories, watermarks. Warm off-white uniform presentation background. Spacious professionally aligned sheet with enough whitespace between every silhouette. Maintain same identity, markings and scale across action poses. Include no invented personal name. Text only short English labels as specified. This is an art-direction and pose sheet, not a claimed machine-ready animation atlas.
```

## 01-round-companion · 01 圆脸桌面伴侣

Shared identity block, then:

```text
Direction A: ROUND COMPANION. Landscape design board. A charming broad-headed seal-point cat with substantial cheeks, compact sturdy seated body, relatively small ears, clear dark mask and ice-blue irises. A 32x32 logical pixel design language, enlarged with nearest-neighbor appearance. Do not enlarge eyes into anime saucers. Header "01 / ROUND COMPANION". Upper third: three large identity poses labelled "FRONT", "SIDE", "BACK"; front sitting with dark tail curled beside flank, side displays fawn body against dark legs and tail, back displays the darker back shading and dark tail. Lower two thirds: two rows of four smaller but highly legible action drawings with labels "IDLE", "BLINK", "LOOK UP", "TAIL SWAY", "TYPE L", "TYPE R", "LOAF", "SLEEP". TYPE L and TYPE R include the same small neutral gray keyboard, visibly alternately raised and pressed dark paws, both paws always present and anatomically attached. LOOK UP raises chin slightly. SLEEP rests broad head on paws, dark tail wraps around body. A quiet affectionate attentive expression. The mask, blue eyes and cream bib must read clearly without the face becoming a solid black blob. The presentation background MUST be a flat uniform warm off-white (#F7F2E8) exactly like a printed design board: absolutely NO dark background, NO vignette, NO glow or halo around the cats, NO lighting effects; labels in dark brown text.
```

## 02-photo-faithful · 02 原照比例

Shared identity block, then:

```text
Direction B: PHOTO FAITHFUL. Landscape design board. Keep the reference photograph proportions: an adult sturdy seal-point Siamese seated upright with front paws together, chest bib forward, tail resting behind, slightly wide-eyed alert stare. A 48x48 logical pixel design language, enlarged with nearest-neighbor appearance. Header "02 / PHOTO FAITHFUL". Upper third: three large identity poses labelled "FRONT", "SIDE", "BACK"; front is the seated photo pose, side shows the standing cat with dark tail held up, back shows darker back shading and dark tail. Lower two thirds: two rows of four smaller but highly legible action drawings with labels "IDLE", "BLINK", "LOOK UP", "STEP 1", "STEP 2", "TYPE L", "TYPE R", "SLEEP". STEP 1 and STEP 2 are a clear alternating walk cycle with different legs forward. TYPE L and TYPE R include the same small neutral gray keyboard, paws alternately raised and pressed, both paws always present. SLEEP is a curled loaf with the dark tail wrapped along the body. Calm dignified expression, mask and pale blue eyes always readable.
```

## 03-pocket-retro · 03 复古小比例

Shared identity block, then:

```text
Direction C: POCKET MIDI. Landscape design board. Very compact retro handheld-game sprite design with chunky visible pixels and smart economical clusters; target 24x24 logical pixel vocabulary, much simpler and fewer pixels than detailed sprites. Broad rounded head and sturdy compact body, tiny black nose inside the dark mask, two pale ice-blue iris clusters with dark pupils, clear cream-white bib, dark seal-brown ears, legs, paws and a thick dark tail that remains readable. Header "03 / POCKET MIDI". Upper third: three large identity poses labelled "FRONT", "SIDE", "BACK". Lower two thirds: two rows of four action poses labelled "IDLE", "BLINK", "LOOK UP", "EAR TWITCH", "TYPE L", "TYPE R", "TINY HOP", "SLEEP". TYPE L and TYPE R include same minimal gray keyboard, paws alternate up/down without disappearing, preserve the mask, bib and dark-point anchors. Tiny hop raises body while paws tuck, avoid dramatic jump. Sleep becomes a low compact fawn loaf with dark mask, dark paws and wrapped dark tail. Favor strong silhouette and readable facial identity at small display sizes. The presentation background MUST be a flat uniform warm off-white (#F7F2E8) exactly like a printed design board: absolutely NO dark background, NO vignette, NO glow or halo around the cats, NO lighting effects; labels in dark brown text. Despite minimalism this must look like the exact adult seal-point Siamese reference rather than a generic icon.
```

## 06-pocket-actions-key · 八姿态图集

Inputs: image 1 = 03-pocket-retro.png (selected sheet), image 2 = the cat photograph.

```text
Create a game animation sprite atlas based EXACTLY on the attached "03 / POCKET MIDI" reference design sheet (image 1), especially its smaller IDLE and TYPE poses, not a taller realistic cat. Image 2 is the real cat photograph for colour and identity only. Compact cute chunky seal-point Siamese with large broad head, short sturdy body and legs, dark seal-brown face mask with a lighter fawn band between mask and ears, pale ice-blue eyes with dark pupils, tiny black nose, bright cream-white chest bib, warm fawn body, dark seal-brown ears, legs and paws, thick upright dark seal-brown tail to viewer LEFT. Must retain charming pocket proportions from reference and clearly visible upright dark tail; NO tabby stripes, NO rings, NOT gray or silver, NOT orange. Simple flat limited-palette pixel art, crisp large square pixel clusters, no fur noise, no gradient, no dithering, no blur.
Canvas EXACTLY 1536x1024, landscape. EXACTLY 4 COLUMNS and 2 ROWS, uniform cells 384x512, one isolated cat in each. No text/labels/grid/keyboard/props/shadows. Entire background perfectly uniform #FF00FF magenta for removal. Each cat must stay completely INSIDE its cell with 40px left and right gutters (never touch boundaries). Same scale and same baseline in each cell. No overlap between cells. For ALL first six poses keep identical body, tail, head proportions, ear positions and markings, changing only specified feature. Front cat viewed very slightly from above like reference.
Top row left to right:
1 idle, compact attentive cat, two front paws resting at baseline and upright dark tail.
2 typing viewer-left paw slightly lifted and forward, right paw grounded; BOTH paws visible and attached; head body tail unchanged.
3 typing viewer-right paw slightly lifted and forward, left paw grounded; BOTH paws visible and attached; head body tail unchanged.
4 looking up, chin lifted a little and pupils looking upward, body and raised tail unchanged.
Bottom row left to right:
5 blinking: EXACT same as idle with only eyes closed into curved slits.
6 sleepy half-closed eyes: EXACT same as idle with only upper eyelids lowered.
7 sleeping: same cat curled into low horizontal shape head resting on paws eyes closed, dark tail wrapped along back/body. Keep same head scale, same baseline, more blank magenta above.
8 ear twitch: EXACT same as idle with only one ear angled slightly.
These are animation frames of ONE CAT. Keep silhouette stable in typing/blink/night to avoid jitter. Exaggerate paw change enough to read on tiny screen but do not wave above chin. Simple adorable pixel-game art like selected reference.
```
