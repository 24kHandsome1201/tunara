# conduit-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _conduit_user_zdotdir="${CONDUIT_USER_ZDOTDIR:-$HOME}"
  [ -f "$_conduit_user_zdotdir/.zprofile" ] && source "$_conduit_user_zdotdir/.zprofile"
  unset _conduit_user_zdotdir
}
:
