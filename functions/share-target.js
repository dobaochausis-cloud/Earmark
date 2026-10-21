// The Share menu normally hands files to the service worker (public/sw.js).
// If that isn't running yet, just open the app instead of showing an error.
export async function onRequestPost() {
  return Response.redirect("https://" + "earmark-4wf.pages.dev/", 303);
}
