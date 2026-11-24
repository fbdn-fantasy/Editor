use std::{env, sync::mpsc::Sender};
use zbus::{blocking::Connection, fdo, interface};

type Launches = Sender<(Vec<String>, String)>;

// Keep the wire protocol used by earlier Editor releases so a running window
// can still accept file associations during an upgrade.
struct Receiver(Launches);

#[interface(name = "org.SingleInstance.DBus")]
impl Receiver {
    fn execute_callback(&self, argv: Vec<String>, cwd: String) -> fdo::Result<()> {
        self.0.send((argv, cwd)).map_err(|_| {
            fdo::Error::Failed("The editor is closing and cannot accept new files.".into())
        })
    }
}

pub enum Instance {
    Forwarded,
    // The primary holds the name for the lifetime of its desktop event loop.
    Primary(Option<Connection>),
}

pub fn acquire(id: &str, launches: Launches) -> zbus::Result<Instance> {
    let name = format!("{id}.SingleInstance");
    let path = format!("/{}", name.replace('.', "/").replace('-', "_"));
    // Elect the owner before constructing Tauri. Secondary launches must
    // never start GTK or Tao's asynchronous X11 input thread just to exit.
    let mut retry = true;
    loop {
        let builder = match zbus::blocking::connection::Builder::session() {
            Ok(builder) => builder,
            Err(_) => return Ok(Instance::Primary(None)),
        };
        match builder
            .serve_at(path.as_str(), Receiver(launches.clone()))?
            .name(name.as_str())?
            .replace_existing_names(false)
            .allow_name_replacements(false)
            .build()
        {
            Ok(connection) => return Ok(Instance::Primary(Some(connection))),
            Err(zbus::Error::NameTaken) => {}
            // A session without a usable bus can still open its own window.
            Err(_) => return Ok(Instance::Primary(None)),
        }
        let argv: Vec<_> = env::args_os()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let cwd = env::current_dir().unwrap_or_default();
        let sent = Connection::session()?.call_method(
            Some(name.as_str()),
            path.as_str(),
            Some("org.SingleInstance.DBus"),
            "ExecuteCallback",
            &(argv, cwd.to_string_lossy().as_ref()),
        );
        match sent {
            Ok(_) => return Ok(Instance::Forwarded),
            Err(zbus::Error::MethodError(ref name, ..))
                if retry && matches!(name.as_str(),
                    "org.freedesktop.DBus.Error.ServiceUnknown" |
                    "org.freedesktop.DBus.Error.NameHasNoOwner") =>
            {
                retry = false;
            }
            Err(error) => return Err(error),
        }
    }
}
