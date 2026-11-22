const PLACEHOLDER_RATIO = 1.5;

export const isMissingWikiImage = (img: HTMLImageElement) => img.naturalHeight > 0 && img.naturalWidth >= PLACEHOLDER_RATIO * img.naturalHeight;

export const loadedMissingWikiImage = (img: HTMLImageElement | null) => img !== null && img.complete && isMissingWikiImage(img);
