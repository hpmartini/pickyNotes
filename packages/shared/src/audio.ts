/** Voice recordings (MediaRecorder): WKWebView yields audio/mp4 (AAC), Chromium audio/webm (Opus). They travel as ordinary `CaptureAttachment`s. */
export const AUDIO_MIME_TYPES = ["audio/mp4", "audio/webm", "audio/ogg", "audio/wav", "audio/mpeg"] as const;

/** Recording length cap in seconds (auto-stop). At ~128 kbit/s AAC that is ~10 MB, so the server's MAX_ATTACHMENT_MB default is 25. */
export const AUDIO_MAX_SECONDS = 600;

/** True for the supported audio containers; codec parameters (`audio/webm;codecs=opus`) are ignored. */
export const isAudioMime = (mime: string): boolean => (AUDIO_MIME_TYPES as readonly string[]).includes(mime.split(";")[0]!.trim().toLowerCase());
