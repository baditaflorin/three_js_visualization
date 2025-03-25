import * as THREE from 'three';
// Import CSS2DRenderer and CSS2DObject
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// --- Config ---
const MATRIX_DROP_COUNT = 300;
const MATRIX_SPEED_MIN = 0.05;
const MATRIX_SPEED_MAX = 0.15;
const CHECK_INTERVAL_MS = 10000;
const PROXY_URL = 'http://localhost:8080/check';

// --- Status Colors ---
const PENDING_COLOR = 0xffff00;
const OK_COLOR = 0x00ff00;
const ERROR_COLOR = 0xff0000;
const TIMEOUT_COLOR = 0xffa500;
const PROXY_ERROR_COLOR = 0x808080;

// --- Globals ---
let scene, camera, renderer, css2DRenderer; // Added css2DRenderer
let matrixDrops = [];
let monitoredEndpoints = []; // { ..., mesh, labelObject, ... }
let nextEndpointId = 0;
const endpointGrid = { cols: 5, spacing: 3 }; // Increased spacing slightly for labels

// --- Initialization ---
function init() {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    // Camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 15;
    camera.position.y = 5;
    camera.lookAt(0, 0, 0);

    // WebGL Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.getElementById('webgl-container').appendChild(renderer.domElement);

    // CSS2D Renderer for Labels
    css2DRenderer = new CSS2DRenderer();
    css2DRenderer.setSize(window.innerWidth, window.innerHeight);
    css2DRenderer.domElement.style.position = 'absolute';
    css2DRenderer.domElement.style.top = '0px';
    document.getElementById('css2d-labels').appendChild(css2DRenderer.domElement); // Append to the new container

    // Lighting
    const ambientLight = new THREE.AmbientLight(0x404040);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 7.5);
    scene.add(directionalLight);

    // Create Matrix Background
    createMatrixBackground();

    // Setup UI Listeners
    document.getElementById('add-endpoint-btn').addEventListener('click', handleAddEndpoint);

    // Handle Window Resize
    window.addEventListener('resize', onWindowResize, false);

    // Start Animation Loop
    animate();

    // Start Periodic Checks
    setInterval(checkAllEndpoints, CHECK_INTERVAL_MS);
}

// --- Matrix Background (Identical) ---
function createMatrixBackground() { /* ... no changes ... */
    const dropGeometry = new THREE.PlaneGeometry(0.1, 0.5);
    const dropMaterial = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.7
    });
    for (let i = 0; i < MATRIX_DROP_COUNT; i++) {
        const drop = new THREE.Mesh(dropGeometry, dropMaterial.clone());
        resetDrop(drop);
        drop.position.y = Math.random() * 50 - 25;
        scene.add(drop);
        matrixDrops.push(drop);
    }
}
function resetDrop(drop) { /* ... no changes ... */
    drop.position.x = Math.random() * 40 - 20;
    drop.position.z = Math.random() * 40 - 20;
    drop.position.y = 25 + Math.random() * 10;
    drop.userData.speed = MATRIX_SPEED_MIN + Math.random() * (MATRIX_SPEED_MAX - MATRIX_SPEED_MIN);
}
function updateMatrixBackground() { /* ... no changes ... */
    matrixDrops.forEach(drop => {
        drop.position.y -= drop.userData.speed;
        drop.material.opacity = Math.max(0, 1.0 - (25 - drop.position.y) / 30);
        if (drop.position.y < -25) {
            resetDrop(drop);
        }
    });
}

// --- Endpoint Monitoring ---
function handleAddEndpoint() { /* ... no changes ... */
    const urlInput = document.getElementById('endpoint-url');
    const portInput = document.getElementById('endpoint-port');
    let urlValue = urlInput.value.trim();
    const portValue = parseInt(portInput.value.trim(), 10);

    if (!urlValue || !portValue) {
        alert('Please provide both URL (including http:// or https://) and Port.');
        return;
    }
    if (!urlValue.startsWith('http://') && !urlValue.startsWith('https://')) {
        alert('URL must start with http:// or https://');
        return;
    }
    if (portValue <= 0 || portValue > 65535) {
        alert('Invalid port number.');
        return;
    }

    const originalUrl = urlValue;
    const originalPort = portValue;

    addEndpointVisual(originalUrl, originalPort);
    urlInput.value = '';
    portInput.value = '';
}

function addEndpointVisual(url, port) {
    // --- Create Cube (Mesh) ---
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({
        color: PENDING_COLOR,
        roughness: 0.5,
        metalness: 0.2
    });
    const cube = new THREE.Mesh(geometry, material);

    const count = monitoredEndpoints.length;
    const gridX = (count % endpointGrid.cols) * endpointGrid.spacing - ((endpointGrid.cols - 1) * endpointGrid.spacing / 2);
    const gridY = 0;
    const gridZ = -Math.floor(count / endpointGrid.cols) * endpointGrid.spacing;

    cube.position.set(gridX, gridY + 0.5, gridZ); // Cube sits on y=0 plane
    scene.add(cube);

    // --- Create Label (CSS2DObject) ---
    let displayUrl = url;
    try {
        const parsed = new URL(url);
        if (!((parsed.protocol === 'http:' && port === 80) || (parsed.protocol === 'https:' && port === 443))) {
            displayUrl = `${parsed.hostname}:${port}`; // Show hostname:port for non-standard
        } else {
            displayUrl = parsed.hostname; // Just hostname for standard ports
        }
        // Limit length for display
        if (displayUrl.length > 30) {
            displayUrl = displayUrl.substring(0, 27) + '...';
        }
    } catch(e) {
        displayUrl = `${url}:${port}`; // Fallback
        if (displayUrl.length > 30) {
            displayUrl = displayUrl.substring(0, 27) + '...';
        }
    }


    const labelDiv = document.createElement('div');
    labelDiv.className = 'endpoint-label status-pending'; // Add base class and initial status
    labelDiv.textContent = displayUrl;

    const labelObject = new CSS2DObject(labelDiv);
    // Position label slightly above the cube center
    labelObject.position.set(0, 1.0, 0); // Position relative to the cube's origin
    cube.add(labelObject); // Attach label to the cube

    // --- Store Data ---
    const endpointData = {
        id: nextEndpointId++,
        url: url,
        port: port,
        displayUrl: displayUrl, // Store the potentially shortened display URL
        mesh: cube,
        labelObject: labelObject, // Store reference to the label
        status: 'PENDING',
        lastCheck: Date.now()
    };
    monitoredEndpoints.push(endpointData);

    checkEndpointStatus(endpointData); // Initial check
}

// Check Status via Proxy (Identical logic, just updates label now)
async function checkEndpointStatus(endpointData) {
    console.log(`Requesting proxy check for: ${endpointData.url}:${endpointData.port}`);
    updateEndpointVisual(endpointData, 'PENDING');

    try {
        const response = await fetch(PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', },
            body: JSON.stringify({ url: endpointData.url, port: endpointData.port }),
        });

        if (!response.ok) {
            console.error(`Proxy Error for ${endpointData.displayUrl}: Status ${response.status}`);
            updateEndpointVisual(endpointData, 'PROXY_ERROR', `Proxy responded with ${response.status}`);
            return;
        }

        const data = await response.json();
        console.log(`Proxy response for ${endpointData.displayUrl}:`, data);
        updateEndpointVisual(endpointData, data.status, data.detail);

    } catch (error) {
        console.error(`Error contacting proxy for ${endpointData.displayUrl}:`, error);
        updateEndpointVisual(endpointData, 'PROXY_ERROR', 'Cannot reach proxy');
    } finally {
        endpointData.lastCheck = Date.now();
    }
}

// Update Visuals (Cube AND Label)
function updateEndpointVisual(endpointData, newStatus, detail = '') {
    endpointData.status = newStatus;
    let targetColor;
    let statusClass = 'status-unknown'; // Default CSS class part

    switch (newStatus) {
        case 'OK':
            targetColor = OK_COLOR;
            statusClass = 'status-ok';
            break;
        case 'ERROR':
            targetColor = ERROR_COLOR;
            statusClass = 'status-error';
            break;
        case 'TIMEOUT':
            targetColor = TIMEOUT_COLOR;
            statusClass = 'status-timeout';
            break;
        case 'PROXY_ERROR':
        case 'INVALID_REQUEST':
            targetColor = PROXY_ERROR_COLOR;
            statusClass = 'status-proxy_error'; // Use same class for simplicity
            break;
        case 'PENDING':
        default:
            targetColor = PENDING_COLOR;
            statusClass = 'status-pending';
            break;
    }

    // Update Cube Color
    if (endpointData.mesh.material.color.getHex() !== targetColor) {
        endpointData.mesh.material.color.setHex(targetColor);
    }

    // Update Label Class for styling
    const labelElement = endpointData.labelObject.element;
    // Reset classes, keep base class, add new status class
    labelElement.className = `endpoint-label ${statusClass}`;

    // Optional: Update label text content if needed (e.g., add detail)
    // labelElement.textContent = `${endpointData.displayUrl} (${newStatus})`;
}

// Check all endpoints periodically (Identical)
function checkAllEndpoints() { /* ... no changes ... */
    console.log("--- Running Periodic Proxy Checks ---");
    monitoredEndpoints.forEach(endpoint => {
        checkEndpointStatus(endpoint);
    });
}

// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate);

    // Update Matrix Background
    updateMatrixBackground();

    // Update Endpoint Animations
    monitoredEndpoints.forEach(ep => {
        if (ep.status === 'OK') {
            const time = Date.now() * 0.002;
            ep.mesh.scale.y = 1.0 + Math.sin(time + ep.id) * 0.05;
        } else {
            ep.mesh.scale.y = 1.0;
        }
        ep.mesh.rotation.y += 0.005;
    });

    // Render WebGL Scene
    renderer.render(scene, camera);
    // Render CSS2D Scene (Labels)
    css2DRenderer.render(scene, camera);
}

// --- Event Handlers ---
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    // Resize both renderers
    renderer.setSize(window.innerWidth, window.innerHeight);
    css2DRenderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Start ---
init();