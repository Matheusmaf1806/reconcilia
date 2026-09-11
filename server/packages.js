// Server-side source of truth for package prices.
// Never trust a price sent by the client - always look it up here.
const PACKAGES = {
  'The sweet one': { priceCents: 5900, description: 'Teddy bear, Nutella, Ferrero Rocher, Milka + Snickers, personalized note.' },
  'The little gesture': { priceCents: 9900, description: 'Teddy bear, a small fresh flower bouquet, Ferrero Rocher + Milka, personalized note.' },
  'The apology': { priceCents: 17900, description: "Teddy bear, Welch's grape juice, Nutella, Pringles, Lindt, Ferrero Rocher, M&M's, Kinder Bueno + assorted candy." },
  'The missing you': { priceCents: 22900, description: "Teddy bear, premium chocolate pretzels, Welch's, Nutella, Pringles, Lindt, premium nuts + full-size handwritten love note." },
};

function getPackage(name) {
  return PACKAGES[name] || null;
}

module.exports = { PACKAGES, getPackage };
