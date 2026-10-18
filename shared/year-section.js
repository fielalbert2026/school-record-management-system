/* Year-Section helper — shared by index.html (sign-in) and the Scheduler.
 *
 * Format: "<year>-<section>", e.g. "3rd-4".
 *   - year    : 1st, 2nd, 3rd, 4th ... (a bare number such as "3" is accepted)
 *   - section : 1, 2, 3 ... (letters such as "A" also work)
 *   - 0 in either position means "undefined / unknown" for that part.
 *     "3rd-0" = 3rd Year, section unknown.   "0-4" = year unknown, Section 4.
 *
 * Matching rule (user vs. a schedule row):
 *   - A row part set to 0 is open to everyone on that part
 *     ("3rd-0" = every 3rd-year section, "0-0" = everyone).
 *   - A user part set to 0 is unknown, so it can only match rows that are
 *     open on that part.
 *   - A blank row value counts as "0-0" (open to everyone), so existing
 *     rows keep working until you fill the column in.
 *   - A row value that isn't a valid Year-Section is treated as closed
 *     (hidden from non-Masters) so a typo never leaks a schedule.
 *
 * IMPORTANT: this is a display filter, not access control. The workbook is
 * read from a public repo and the session lives in sessionStorage, so it
 * decides what the UI shows, nothing more. It never touches, stores or
 * reads any auth/session token.
 */
(function(){
  function ordinal(n){
    const v = n % 100;
    if(v >= 11 && v <= 13) return n + 'th';
    return n + ({1:'st', 2:'nd', 3:'rd'}[n % 10] || 'th');
  }

  // Returns {year:Number, section:String, valid:Boolean, blank:Boolean}.
  // year 0 / section '0' = unknown. Never throws.
  function parse(raw){
    const s = String(raw == null ? '' : raw).trim();
    if(s === '') return { year:0, section:'0', valid:true, blank:true };
    const m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s*-\s*([A-Za-z0-9]{1,6})$/i);
    if(!m) return { year:0, section:'0', valid:false, blank:false };
    const year = parseInt(m[1], 10);
    let section = m[2].toLowerCase();
    if(/^\d+$/.test(section)) section = String(parseInt(section, 10));
    return { year, section, valid:true, blank:false };
  }

  // Canonical text, e.g. "3rd-4". Unknown parts print as 0.
  function format(ys){
    const p = (ys && typeof ys === 'object') ? ys : parse(ys);
    return (p.year ? ordinal(p.year) : '0') + '-' + String(p.section).toUpperCase();
  }

  // Human wording, e.g. "3rd Year · Section 4" / "3rd Year · section not set".
  function describe(ys){
    const p = (ys && typeof ys === 'object') ? ys : parse(ys);
    const y = p.year ? ordinal(p.year) + ' Year' : 'year level not set';
    const s = p.section !== '0' ? 'Section ' + String(p.section).toUpperCase() : 'section not set';
    return y + ' · ' + s;
  }

  function matches(user, row){
    const u = (user && typeof user === 'object') ? user : parse(user);
    const r = (row && typeof row === 'object') ? row : parse(row);
    if(!r.valid) return false;
    const yearOk = r.year === 0 || (u.year !== 0 && u.year === r.year);
    const sectionOk = r.section === '0' || (u.section !== '0' && u.section === r.section);
    return yearOk && sectionOk;
  }

  // Why the "Unavailable" notice is showing, in plain words.
  function unavailableReason(user){
    const u = (user && typeof user === 'object') ? user : parse(user);
    if(u.year === 0 && u.section === '0')
      return "Your year level and section aren't set on your account yet, so only schedules open to everyone can be shown.";
    if(u.year === 0)
      return "Your year level isn't set on your account yet, so only schedules open to every year can be shown.";
    if(u.section === '0')
      return "Your section isn't set on your account yet, so only schedules open to every section of your year can be shown.";
    return 'No schedule has been published for ' + describe(u) + ' yet.';
  }

  window.SRMS = window.SRMS || {};
  window.SRMS.yearSection = { parse, format, describe, matches, unavailableReason };
})();
