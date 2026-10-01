// The zipcoin logo, concept D "Zipper Z" (site/brand/): a Z whose diagonal is a closed zipper, on a night coin with a
// green rim. This is the small drawing, for 48 px and below. The rim takes currentColor (give it text-pad); the zipper
// is drawn before the bars so they trim its ends, which keeps the SVG free of ids.

export const MARK_PATHS = {
  z: "M268 190H384L244 322H128Z",
  zip: "M323.7 158 290.9 191.6 319.5 219.6 286.7 253.2 258.1 225.2 225.3 258.8 253.9 286.8 221.1 320.4 192.5 292.4 159.7 326",
  bars: "M136 118H376A8 8 0 0 1 384 126V184A8 8 0 0 1 376 192H136A8 8 0 0 1 128 184V126A8 8 0 0 1 136 118ZM136 320H376A8 8 0 0 1 384 328V386A8 8 0 0 1 376 394H136A8 8 0 0 1 128 386V328A8 8 0 0 1 136 320Z",
};

export function Mark({ className, rim = "currentColor" }: { className?: string; rim?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden>
      <circle cx="256" cy="256" r="256" fill="#101b1a" />
      <circle cx="256" cy="256" r="236" fill="none" stroke={rim} strokeWidth="40" />
      <path d={MARK_PATHS.z} fill="#f4f0e1" />
      <path d={MARK_PATHS.zip} fill="none" stroke="#101b1a" strokeWidth="16" />
      <path d={MARK_PATHS.bars} fill="#f4f0e1" />
    </svg>
  );
}
