use super::*;
use std::process::Command;
use zbus::{OwnedObjectPath, OwnedVariant};

const ADAPTER: &str = "/org/bluez/hci0";
const HEALTHY_ID: &str = "12:23:34:45:56:67";
const MISSING_ID: &str = "12:23:34:45:56:78";
const SLOW_ID: &str = "12:23:34:45:56:89";
const NO_BATTERY_ID: &str = "12:23:34:45:56:90";
const UNRESOLVED_ID: &str = "12:23:34:45:56:91";

type ManagedObjects = HashMap<OwnedObjectPath, HashMap<String, HashMap<String, OwnedVariant>>>;

struct ObjectManager(ManagedObjects);

#[zbus::interface(name = "org.freedesktop.DBus.ObjectManager")]
impl ObjectManager {
    fn get_managed_objects(&self) -> &ManagedObjects {
        &self.0
    }
}

struct MockAdapter;

#[zbus::interface(name = "org.bluez.Adapter1")]
impl MockAdapter {
    #[zbus(property)]
    fn powered(&self) -> bool {
        true
    }
}

struct MockDevice {
    services_resolved: bool,
}

#[zbus::interface(name = "org.bluez.Device1")]
impl MockDevice {
    fn connect(&self) {}

    #[zbus(property)]
    fn alias(&self) -> &str {
        "Test keyboard"
    }

    #[zbus(property)]
    fn connected(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn services_resolved(&self) -> bool {
        self.services_resolved
    }
}

enum ServiceUuid {
    Available,
    Missing,
    Delayed,
}

#[zbus::interface(name = "org.bluez.GattService1")]
impl ServiceUuid {
    #[zbus(property, name = "UUID")]
    async fn uuid(&self) -> zbus::fdo::Result<String> {
        match self {
            Self::Available => {}
            Self::Missing => {
                return Err(zbus::fdo::Error::UnknownObject("Service removed".into()));
            }
            Self::Delayed => sleep(SERVICES_DISCOVERY_TIMEOUT + Duration::from_secs(2)).await,
        }
        Ok(BATTERY_SERVICE_UUID.to_string())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gatt_uuid_queries_are_bounded_and_isolated_per_device() {
    const CHILD_ENV: &str = "ZMK_GATT_UUID_TEST_CHILD";
    if std::env::var_os(CHILD_ENV).is_none() {
        let output = Command::new("dbus-run-session")
            .args([
                "--",
                "sh",
                "-c",
                "DBUS_SYSTEM_BUS_ADDRESS=\"$DBUS_SESSION_BUS_ADDRESS\" exec \"$@\"",
                "sh",
            ])
            .arg(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "ble::bluez_test::gatt_uuid_queries_are_bounded_and_isolated_per_device",
                "--nocapture",
            ])
            .env(CHILD_ENV, "1")
            .output()
            .expect("dbus-run-session is required for the GATT discovery test");
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    let mut objects = ManagedObjects::new();
    let mut register = |path: &str, interface: &str| {
        objects.insert(
            OwnedObjectPath::try_from(path).unwrap(),
            HashMap::from([(interface.to_string(), HashMap::new())]),
        );
    };
    register(ADAPTER, "org.bluez.Adapter1");
    let mut builder = zbus::connection::Builder::session()
        .name("org.bluez")
        .serve_at(ADAPTER, MockAdapter);
    for (id, behavior) in [
        (HEALTHY_ID, Some(ServiceUuid::Available)),
        (MISSING_ID, Some(ServiceUuid::Missing)),
        (SLOW_ID, Some(ServiceUuid::Delayed)),
        (NO_BATTERY_ID, None),
        (UNRESOLVED_ID, None),
    ] {
        let device_path = format!("{ADAPTER}/dev_{}", id.replace(':', "_"));
        register(&device_path, "org.bluez.Device1");
        if let Some(behavior) = behavior {
            let service_path = format!("{device_path}/service0001");
            register(&service_path, "org.bluez.GattService1");
            builder = builder.serve_at(service_path, behavior);
        }
        builder = builder.serve_at(
            device_path,
            MockDevice {
                services_resolved: id != UNRESOLVED_ID,
            },
        );
    }
    let _bluez = builder
        .serve_at("/", ObjectManager(objects))
        .build()
        .await
        .unwrap();

    let adapter = get_adapter().await.unwrap();
    let unresolved = get_target_device(&adapter, UNRESOLVED_ID).await.unwrap();
    let slow_uuid = get_target_device(&adapter, SLOW_ID).await.unwrap();
    let (devices, unresolved_result, slow_uuid_result) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(15), list_battery_devices()),
        get_battery_characteristic_contexts(&unresolved),
        get_battery_characteristic_contexts(&slow_uuid),
    );
    let devices = devices
        .expect("an unrelated UUID read must not block the device list")
        .unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].id, HEALTHY_ID);
    assert!(matches!(
        unresolved_result,
        Err(GattDiscoveryError::ServiceListTimedOut)
    ));
    assert!(matches!(
        slow_uuid_result,
        Err(GattDiscoveryError::ServiceUuidTimedOut)
    ));

    let missing = get_target_device(&adapter, MISSING_ID).await.unwrap();
    assert!(matches!(
        get_battery_characteristic_contexts(&missing).await,
        Err(GattDiscoveryError::Bluetooth(_))
    ));

    // A connected device can lack the battery service or its level characteristic.
    for id in [NO_BATTERY_ID, HEALTHY_ID] {
        assert_eq!(
            get_battery_info(id.to_string()).await.unwrap_err(),
            "Battery level characteristic not found"
        );
    }
}
