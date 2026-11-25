use super::*;
use std::process::Command;
use std::sync::atomic::AtomicBool;
use zbus::{OwnedObjectPath, OwnedVariant};

const ADAPTER: &str = "/org/bluez/hci0";
const HEALTHY_ID: &str = "12:23:34:45:56:A1";
const MISSING_ID: &str = "12:23:34:45:56:78";
const SLOW_ID: &str = "12:23:34:45:56:89";
const NO_BATTERY_ID: &str = "12:23:34:45:56:90";
const UNRESOLVED_ID: &str = "12:23:34:45:56:91";
const SLOW_DESCRIPTOR_ID: &str = "12:23:34:45:56:92";
const NO_BATTERY_LEVEL_ID: &str = "12:23:34:45:56:93";
const DISCONNECTED_ID: &str = "12:23:34:45:56:94";

static BLOCK_UNRELATED_CONNECTION: AtomicBool = AtomicBool::new(false);
static DESCRIPTOR_READ_STARTED: AtomicBool = AtomicBool::new(false);

type ManagedObjects = HashMap<OwnedObjectPath, HashMap<String, HashMap<String, OwnedVariant>>>;
type ReadOptions = HashMap<String, OwnedVariant>;

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
    connected: bool,
    services_resolved: bool,
    connection_can_stall: bool,
}

#[zbus::interface(name = "org.bluez.Device1")]
impl MockDevice {
    fn connect(&self) {}

    #[zbus(property)]
    fn alias(&self) -> &str {
        "Test keyboard"
    }

    #[zbus(property)]
    async fn connected(&self) -> bool {
        if self.connection_can_stall && BLOCK_UNRELATED_CONNECTION.load(Ordering::Relaxed) {
            std::future::pending::<()>().await;
        }
        self.connected
    }

    #[zbus(property)]
    fn services_resolved(&self) -> bool {
        self.services_resolved
    }
}

enum ServiceUuid {
    Available,
    Missing,
    Delayed(Duration),
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
            Self::Delayed(duration) => sleep(*duration).await,
        }
        Ok(BATTERY_SERVICE_UUID.to_string())
    }
}

struct MockBatteryLevel;

#[zbus::interface(name = "org.bluez.GattCharacteristic1")]
impl MockBatteryLevel {
    #[zbus(property, name = "UUID")]
    fn uuid(&self) -> String {
        BATTERY_LEVEL_UUID.to_string()
    }

    fn read_value(&self, _options: ReadOptions) -> Vec<u8> {
        vec![84]
    }
}

struct SlowUserDescription;

#[zbus::interface(name = "org.bluez.GattDescriptor1")]
impl SlowUserDescription {
    #[zbus(property, name = "UUID")]
    fn uuid(&self) -> String {
        CHARACTERISTIC_USER_DESCRIPTION.to_string()
    }

    async fn read_value(&self, _options: ReadOptions) -> Vec<u8> {
        DESCRIPTOR_READ_STARTED.store(true, Ordering::Relaxed);
        sleep(Duration::from_secs(6)).await;
        b"Peripheral".to_vec()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gatt_discovery_is_bounded_and_registered_polls_are_isolated() {
    const CHILD_ENV: &str = "ZMK_GATT_TEST_CHILD";
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
                "ble::bluez_test::gatt_discovery_is_bounded_and_registered_polls_are_isolated",
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
        (
            SLOW_ID,
            Some(ServiceUuid::Delayed(
                GATT_DISCOVERY_TIMEOUT + Duration::from_secs(2),
            )),
        ),
        (NO_BATTERY_ID, None),
        (UNRESOLVED_ID, None),
        (
            SLOW_DESCRIPTOR_ID,
            Some(ServiceUuid::Delayed(Duration::from_secs(4))),
        ),
        (NO_BATTERY_LEVEL_ID, Some(ServiceUuid::Available)),
        (DISCONNECTED_ID, None),
    ] {
        let device_path = format!("{ADAPTER}/dev_{}", id.replace(':', "_"));
        register(&device_path, "org.bluez.Device1");
        if let Some(behavior) = behavior {
            let service_path = format!("{device_path}/service0001");
            register(&service_path, "org.bluez.GattService1");
            builder = builder.serve_at(service_path.clone(), behavior);
            if matches!(id, HEALTHY_ID | SLOW_DESCRIPTOR_ID) {
                let characteristic_path = format!("{service_path}/char0001");
                register(&characteristic_path, "org.bluez.GattCharacteristic1");
                builder = builder.serve_at(characteristic_path.clone(), MockBatteryLevel);
                if id == SLOW_DESCRIPTOR_ID {
                    let descriptor_path = format!("{characteristic_path}/desc0001");
                    register(&descriptor_path, "org.bluez.GattDescriptor1");
                    builder = builder.serve_at(descriptor_path, SlowUserDescription);
                }
            }
        }
        builder = builder.serve_at(
            device_path,
            MockDevice {
                connected: id != DISCONNECTED_ID,
                services_resolved: id != UNRESOLVED_ID,
                connection_can_stall: id == UNRESOLVED_ID,
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
    let slow_descriptor = get_target_device(&adapter, SLOW_DESCRIPTOR_ID)
        .await
        .unwrap();
    let (devices, unresolved_result, slow_uuid_result, slow_descriptor_result) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(15), list_battery_devices()),
        get_battery_characteristic_contexts(&unresolved),
        get_battery_characteristic_contexts(&slow_uuid),
        tokio::time::timeout(
            GATT_DISCOVERY_TIMEOUT + Duration::from_secs(5),
            get_battery_characteristic_contexts(&slow_descriptor)
        ),
    );
    let devices = devices
        .expect("an unrelated UUID read must not block the device list")
        .unwrap();
    let mut ids: Vec<_> = devices.iter().map(|device| device.id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, [SLOW_DESCRIPTOR_ID, NO_BATTERY_LEVEL_ID, HEALTHY_ID]);
    assert!(matches!(
        unresolved_result,
        Err(GattDiscoveryError::ServiceListTimedOut)
    ));
    assert!(matches!(
        slow_uuid_result,
        Err(GattDiscoveryError::ServiceUuidTimedOut)
    ));
    assert!(matches!(
        slow_descriptor_result,
        Ok(Err(GattDiscoveryError::CharacteristicsTimedOut))
    ));
    assert!(DESCRIPTOR_READ_STARTED.load(Ordering::Relaxed));

    let missing = get_target_device(&adapter, MISSING_ID).await.unwrap();
    assert!(matches!(
        get_battery_characteristic_contexts(&missing).await,
        Err(GattDiscoveryError::Bluetooth(_))
    ));

    // A connected device can lack the battery service or its level characteristic.
    for id in [NO_BATTERY_ID, NO_BATTERY_LEVEL_ID] {
        assert_eq!(
            get_battery_info(id.to_string()).await.unwrap_err(),
            "Battery level characteristic not found"
        );
    }

    for id in [DISCONNECTED_ID, "invalid-address", "12:23:34:45:56:00"] {
        assert_eq!(
            get_target_device(&adapter, id).await.unwrap_err(),
            "Device not found"
        );
    }

    BLOCK_UNRELATED_CONNECTION.store(true, Ordering::Relaxed);
    let battery = tokio::time::timeout(
        Duration::from_secs(5),
        get_battery_info(HEALTHY_ID.to_string()),
    )
    .await
    .expect("an unrelated connection query must not block a registered device poll")
    .unwrap();
    assert_eq!(battery.len(), 1);
    assert_eq!(battery[0].battery_level, Some(84));
}
