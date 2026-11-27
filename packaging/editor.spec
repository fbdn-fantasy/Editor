%bcond_with legacy_update
%if %{with legacy_update}
Name:           editor-text
%else
Name:           editor
%endif
Version:        1.0.4
Release:        1
Summary:        Text and source-code editor
License:        AGPL-3.0-only
BuildArch:      x86_64
Requires:       webkit2gtk4.1
Requires:       gtk3
Requires:       desktop-file-utils
Requires:       xdg-user-dirs
Requires:       /usr/bin/gio
Requires:       /usr/bin/flock
Requires:       util-linux
Requires:       /usr/bin/curl
Requires:       /usr/bin/pkexec
Requires:       /usr/bin/dnf
Provides:       Editor = %{version}-%{release}
Obsoletes:      Editor < 1.0.4-1
%if %{without legacy_update}
Provides:       editor-text = %{version}-%{release}
Obsoletes:      editor-text <= %{version}-%{release}
%endif
%global debug_package %{nil}

%description
Desktop editor for plain text, configuration files and source code.

%install
mkdir -p %{buildroot}
cp -a %{_sourcedir}/payload/usr %{_sourcedir}/payload/etc %{buildroot}/

%posttrans
%{_libexecdir}/editor/setup-active-desktops || :

%files
%dir %{_libexecdir}/editor
%{_libexecdir}/editor/editor
%{_libexecdir}/editor/desktop-setup
%{_libexecdir}/editor/setup-active-desktops
%{_sysconfdir}/xdg/autostart/app.editor.TextEditor-setup.desktop
%{_datadir}/applications/app.editor.TextEditor.desktop
%{_datadir}/icons/hicolor/*/apps/app.editor.TextEditor.png
%dir %{_datadir}/doc/editor
%dir %{_datadir}/editor
%{_datadir}/editor/install-format
%if %{with legacy_update}
%{_datadir}/editor/legacy-update/
%endif
%license %{_datadir}/doc/editor/LICENSE
%license %{_datadir}/doc/editor/NOTICE
%license %{_datadir}/doc/editor/THIRD-PARTY-NOTICES.txt
