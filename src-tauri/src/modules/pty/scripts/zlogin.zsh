# tunara-shell-integration (zlogin)
#
# This is the LAST init file zsh runs before entering the prompt loop, so its
# exit status becomes `$?` for the very first prompt. Without the trailing `:`,
# users without a personal ~/.zlogin (the common case) hit a non-zero $? on
# first render — themes that condition prompt color on `%?` (robbyrussell etc.)
# show a red error indicator on a clean shell start.
{
  _tunara_user_zdotdir="${TUNARA_USER_ZDOTDIR:-$HOME}"
  [ -f "$_tunara_user_zdotdir/.zlogin" ] && source "$_tunara_user_zdotdir/.zlogin"
  unset _tunara_user_zdotdir
}
:
