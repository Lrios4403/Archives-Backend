import { getWarcFolderStats } from "../disk";

// GET /api/warcs/status
// Healthy:  { status: "ok", files, total_bytes, date, scan_ms }
// Failure:  { status: "error", message, date }
//
// `files`       = number of .warc files in the warc folder.
// `total_bytes` = total on-disk size of those .warc files, in bytes (NOT how much
//                 has been parsed into the database).
// `date`        = when these NUMBERS were read, not when the request arrived.
//                 They come from a cached scan (see getWarcFolderStats), so
//                 stamping them with "now" would claim a freshness they do not
//                 have — and the frontend already treats this field as the time
//                 of the reading.
// `scan_ms`     = how long the scan behind those numbers took. Cheap to send and
//                 the only early warning that the mount is degrading: this went
//                 from milliseconds to nearly four minutes without anything
//                 reporting it.
// `status`/`message` let the frontend surface a banner when the backend is
// unhealthy.
//
// This route no longer walks the NAS per request. It used to, via a helper that
// called the SYNCHRONOUS Bun.file(p).size once per file — roughly 1,800 blocking
// CIFS round trips on the event loop, which stalled every other route on the
// server for the duration, not just this one.
export const statusRoute = (): Promise<Response> =>
  getWarcFolderStats("./warcs/")
    .then(({ files, totalBytes, at, scanMs }) =>
      Response.json({
        status: "ok",
        files,
        total_bytes: totalBytes,
        date: new Date(at).toISOString(),
        scan_ms: scanMs,
      }),
    )
    .catch((err) => {
      console.error("statusRoute error:", err);
      return Response.json({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to read the warc folder",
        date: new Date().toISOString(),
      });
    });
