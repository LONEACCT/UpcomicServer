const db = require('../db');

// Blocks a route unless the site owner is logged into /admin
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

// Blocks a route unless a visitor has an account and is logged in
function requireUser(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

// Loads the current user (if any) onto req.currentUser for every request,
// and lazily flips any expired VIP codes/accounts to 'expired' as it goes.
function loadCurrentUser(req, res, next) {
  res.locals.currentUser = null;
  if (req.session && req.session.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      const isVip = user.vip_expires_at && new Date(user.vip_expires_at) > new Date();
      req.currentUser = user;
      res.locals.currentUser = { ...user, isVip };
    }
  }
  next();
}

// Blocks a route unless the logged-in user currently has active VIP.
// If they were VIP before but it lapsed, we show an "expired" page instead
// of a generic locked page, per the site's spec.
function requireVip(req, res, next) {
  if (!req.currentUser) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  const isVip = req.currentUser.vip_expires_at && new Date(req.currentUser.vip_expires_at) > new Date();
  if (isVip) return next();

  const everHadVip = !!req.currentUser.vip_expires_at;
  return res.render('vip-expired', { everHadVip });
}

module.exports = { requireAdmin, requireUser, loadCurrentUser, requireVip };
