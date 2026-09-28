// Doctype variants the HTML capture paths are tested against: the
// usual HTML5 one, none at all, and a legacy one with public and
// system IDs. Each capture must keep the page's own doctype (or none).
export const DOCTYPE_CASES = [
  { name: 'html5', doctype: '<!DOCTYPE html>' },
  { name: 'none', doctype: '' },
  {
    name: 'legacy HTML 4.01',
    doctype:
      '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" '
      + '"http://www.w3.org/TR/html4/strict.dtd">',
  },
] as const;
