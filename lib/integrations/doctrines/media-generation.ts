// Media production-prompt doctrine for image/video/speech/music agents.
//
// Loaded lazily into the orchestrator prompt only after
// ActivateIntegrationTools(...) for this capability (see
// lib/integrations/subsystem-manifest.ts + lib/integrations/exposure.ts).
export const MEDIA_GENERATION_DOCTRINE = `
<media_generation_guidance>
Use specialist media agents when the user asks for generated/edited media, or when another agent needs an asset to complete the task. The selected provider/model comes from Settings for that media agent. OpenAI is not a fallback for Google and Google is not a fallback for OpenAI; if Settings says OpenAI, prompt for the OpenAI image model and expect it to work. If Settings says Google, prompt for the Google model and expect it to work.

General delegation rule:
- Do not tell the coder "make a website" just because media is involved. Delegate to coder only when implementation work is needed. For pure images, video, speech, or music, call the appropriate media agent with a production-quality prompt.
- Media prompts should include purpose, audience, format, constraints, and success criteria. Avoid keyword piles. Use descriptive paragraphs and exact instructions.

Image generation and editing:
- Google image model: Nano Banana 2, \`gemini-3.1-flash-image-preview\`. OpenAI image model: \`gpt-image-2\`.
- Describe the scene, not just keywords. Include the subject, environment, action, composition, visual hierarchy, materials/textures, lighting, mood, color palette, camera angle, lens/focal length, depth of field, and final use case.
- For photorealistic work, use photography language: close-up/wide/macro/low-angle/45-degree/top-down/isometric, lens type such as 35mm/50mm/85mm/macro, studio softbox/golden hour/neon/rim light, aperture/bokeh/sharp focus, product surface, shadows, and background treatment.
- For product mockups/commercial shots, specify product material, exact placement, brand/logo placement, reflection/shadow behavior, camera angle, surface, cleanliness, resolution, and whether the image is ecommerce, editorial, ad, or social.
- For icons, stickers, and assets, specify style, outline weight, cel-shading/3D/tactile/flat/vector-like rendering, background color, and "no text" when text is not desired. Gemini image generation does not produce true transparent backgrounds; request white/solid background instead.
- For images containing text, write the exact visible text and describe the type style, placement, hierarchy, and layout. For professional text-heavy assets, prefer the higher-fidelity model selected in Settings. Best results often come from drafting the text first, then generating the image with that exact copy.
- For minimalist or negative-space images, explicitly say where the subject sits and where empty space must remain for overlay text.
- For sequential art/storyboards/comics, define number of panels, character continuity, scene progression, style, panel composition, speech text if any, and what should remain consistent across panels.
- For edits, provide the input image(s) plus a precise change list: what to add/remove/change, what must remain unchanged, and which region is being edited. Use semantic masking language such as "change only the blue sofa" or "keep the rest of the room unchanged."
- For style transfer, say to preserve composition, object placement, identity, and perspective while changing the rendering style. Do not ask for a living artist imitation when avoidable; describe visual traits instead.
- For multiple-reference composition, identify which reference supplies each element: subject, garment/product/logo, pose, background, lighting, color grade. For Gemini 3.1 Flash Image, up to 14 references are possible, with practical high-fidelity limits of up to 10 objects and 4 characters in one workflow.
- For high-fidelity faces, logos, products, or documents, describe critical details to preserve and explicitly say they must remain unchanged except for the requested edit.
- For sketches/rough drafts, say which lines/profile/proportions must be preserved and what finish to add: showroom photo, production concept art, polished UI, etc.
- Aspect ratio and image size matter. Common ratios: \`1:1\`, \`2:3\`, \`3:2\`, \`3:4\`, \`4:3\`, \`4:5\`, \`5:4\`, \`9:16\`, \`16:9\`, \`21:9\`; Gemini 3.1 Flash also supports \`1:4\`, \`4:1\`, \`1:8\`, \`8:1\`. Gemini image sizes are \`512\`, \`1K\`, \`2K\`, \`4K\` with uppercase K.
- Use Google Search/Web grounding when the image depends on current facts such as weather, recent events, charts, maps, or news. Use Image Search grounding only for accurate non-person visual references. Google Image Search grounding cannot be used to search for people, and generated grounded image outputs require source attribution in the UI/result.
- Use positive semantic negatives: instead of "no cars", write "an empty, deserted street with no signs of traffic." Still include critical exclusions when safety or brand constraints require them.

Video generation:
- Google video model: Veo 3.1, \`veo-3.1-generate-preview\`.
- Build the prompt like a shot brief: subject, action, location, time of day, visual style, camera position, camera movement, lens/focus, framing, pacing, lighting, atmosphere, color grade, and the intended emotional beat.
- Include audio direction. Veo can generate dialogue, sound effects, and ambient sound. Put spoken lines in quotes, identify the speaker, and describe delivery, background noise, music bed, or SFX explicitly.
- For cinematic realism, specify shot type and movement: close-up, medium shot, wide shot, dolly-in, handheld, locked-off, crane, tracking shot, rack focus, shallow depth of field, slow motion, etc.
- For animation or stylized video, specify style, material, rendering approach, motion quality, character design, and whether the motion should be smooth, snappy, stop-motion-like, clay-like, anime-like, or graphic.
- Specify output orientation when needed: \`16:9\` landscape or \`9:16\` portrait. Veo 3.1 supports 8-second videos and can target 720p, 1080p, or 4K depending on request/provider settings.
- Image-based direction can use up to three reference images. For first/last-frame generation, describe what changes between the frames and what should remain stable. For extension, describe continuity from the previous clip, not a new unrelated shot.

Speech/TTS generation:
- Google speech model: \`gemini-3.1-flash-tts-preview\`.
- TTS accepts text-only input and produces audio-only output. Begin with a clear instruction like "Synthesize speech from the transcript below" so director notes are not read aloud.
- Single speaker: choose or respect the selected voice, then write performance direction before the transcript. Multi-speaker: use exactly two named speakers; the speaker names in the transcript must exactly match the intended voices.
- The current user request wins over the saved TTS default. If the user asks for dialogue or two voices, author a two-speaker transcript even when Settings currently show single speaker. If the user asks for a monologue, author a single-speaker prompt even when Settings currently show multi speaker.
- Strong prompt structure: \`# AUDIO PROFILE\`, \`## THE SCENE\`, \`### DIRECTOR'S NOTES\`, \`#### TRANSCRIPT\`. Keep directions coherent with the transcript; do not overconstrain every syllable.
- Director notes can specify style, emotion, accent, pace, articulation, breathing, projection, energy, and relationship to the listener. Specific accents work better than broad labels.
- Use inline audio tags for local control: \`[whispers]\`, \`[shouting]\`, \`[laughs]\`, \`[giggles]\`, \`[sighs]\`, \`[gasp]\`, \`[short pause]\`, \`[excitedly]\`, \`[sarcastically]\`, \`[tired]\`, \`[curious]\`, \`[serious]\`, \`[very fast]\`, \`[very slow]\`.
- Available voice names include Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede, Callirrhoe, Autonoe, Enceladus, Iapetus, Umbriel, Algieba, Despina, Erinome, Algenib, Rasalgethi, Laomedeia, Achernar, Alnilam, Schedar, Gacrux, Pulcherrima, Achird, Zubenelgenubi, Vindemiatrix, Sadachbia, Sadaltager, and Sulafat.
- For longer speech, split transcripts into smaller chunks to reduce voice drift. If the model occasionally returns text/500 instead of audio, retrying is appropriate at the integration layer.

Music generation:
- Google music model: Lyria 3 Pro, \`lyria-3-pro-preview\`. This is the Pro/full-song path; do not treat it as a 30-second clip model unless the user asks for a short preview.
- Lead with genre and era: "early 90s hip-hop", "80s synth-pop", "modern EDM mixed with Europop", "cinematic orchestral", "lo-fi jazz hop", etc.
- Include instruments, timbre, production texture, BPM, key/scale, mood, energy curve, vocalist profile, language, and duration. Example details: warm Rhodes, dirty distorted bass, crisp hi-hats, analog pads, wall of fuzzy guitars, walking bass, D minor, 120 BPM.
- Structure matters. Use section tags and flow: \`[Intro]\` -> \`[Verse 1]\` -> \`[Chorus]\` -> \`[Verse 2]\` -> \`[Bridge]\` -> \`[Outro]\`. Describe crescendos, drops, silence, instrument entrances, and transitions.
- Timing can be explicit with timestamps, e.g. \`[0:00 - 0:10] Intro...\`, \`[0:30 - 0:50] Chorus...\`, or "the drop arrives at 22s."
- Lyrics: if the model should write lyrics, specify topic, point of view, language, chorus idea, and emotional arc. If providing custom lyrics, put them after a clear \`Lyrics:\` label and use section headers like \`[Verse]\`, \`[Chorus]\`, \`[Bridge]\`.
- Vocals: specify singer profile by range/timbre/delivery rather than named artists. Examples: crystalline female soprano, warm husky alto, bright male tenor, velvet baritone, raspy weathered rocker.
- For background/game/UI music, explicitly request "Instrumental only, no vocals." Otherwise vocals/lyrics may appear by default.

Safety and output expectations:
- All generated images/audio may include SynthID watermarking depending on provider. Respect rights for uploaded references, logos, likenesses, and copyrighted lyrics.
- Always return the generated artifact/audio/video/image with concise notes about any provider limitation that affected the result.
</media_generation_guidance>
`.trim()
