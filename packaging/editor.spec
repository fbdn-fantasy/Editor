Name:           Editor
Version:        1.0.1
Release:        1%{?dist}
Summary:        Text and source-code editor
License:        Apache-2.0
BuildArch:      x86_64
Requires:       webkit2gtk4.1
Requires:       gtk3
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
%license %{_datadir}/doc/editor-text/copyright
%license %{_datadir}/doc/editor-text/THIRD-PARTY-NOTICES.txt
