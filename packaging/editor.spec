Name:           editor-text
Version:        1.0.3
Release:        1
Summary:        Text and source-code editor
License:        AGPL-3.0-only
BuildArch:      x86_64
Requires:       webkit2gtk4.1
Requires:       gtk3
Requires:       /usr/bin/curl
Requires:       /usr/bin/pkexec
Requires:       /usr/bin/dnf
Provides:       Editor = %{version}-%{release}
Obsoletes:      Editor < %{version}-%{release}
%global debug_package %{nil}

%description
Desktop editor for plain text, configuration files and source code.

%install
mkdir -p %{buildroot}
cp -a %{_sourcedir}/payload/usr %{buildroot}/

%files
%{_bindir}/editor-text
%{_datadir}/applications/app.editor.TextEditor.desktop
%{_datadir}/icons/hicolor/*/apps/app.editor.TextEditor.png
%dir %{_datadir}/doc/editor-text
%dir %{_datadir}/editor-text
%{_datadir}/editor-text/install-format
%license %{_datadir}/doc/editor-text/LICENSE
%license %{_datadir}/doc/editor-text/NOTICE
%license %{_datadir}/doc/editor-text/THIRD-PARTY-NOTICES.txt
