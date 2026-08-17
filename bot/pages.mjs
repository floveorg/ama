// Author page URL generation — shared between bot and web.

export function pageUrlOf(key, webUrl) {
  return (webUrl || 'https://ama.liberada.net') + '/#/u/' + encodeURIComponent(key);
}
