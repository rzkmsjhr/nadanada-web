/**
 * Strictly isolate search results by active search tab ('song', 'video', 'album')
 * so no song, video, or album leaks across tabs.
 */
export function filterSearchResultsByTab(items = [], searchTab = 'song', isVideoFn = null) {
  if (!Array.isArray(items)) return [];
  const tab = String(searchTab || 'song').toLowerCase();
  const checkIsVideo =
    typeof isVideoFn === 'function'
      ? (item) => Boolean(isVideoFn(item))
      : (item) => String(item?.item_type || '').toLowerCase() === 'video';

  if (tab === 'video') {
    return items.filter(
      (item) =>
        item &&
        !item.is_playlist &&
        String(item.item_type || '').toLowerCase() === 'video' &&
        checkIsVideo(item)
    );
  }

  if (tab === 'album') {
    return items.filter(
      (item) =>
        item &&
        (Boolean(item.is_playlist) || String(item.item_type || '').toLowerCase() === 'album')
    );
  }

  return items.filter((item) => {
    if (!item || item.is_playlist) return false;
    const itemType = String(item.item_type || '').toLowerCase();
    if (itemType === 'album' || itemType === 'video') return false;
    return !checkIsVideo(item);
  });
}
