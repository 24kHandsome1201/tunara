# tunara-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _tunara_user_zdotdir="${TUNARA_USER_ZDOTDIR:-$HOME}"
  [ -f "$_tunara_user_zdotdir/.zprofile" ] && source "$_tunara_user_zdotdir/.zprofile"
  unset _tunara_user_zdotdir
}
:
