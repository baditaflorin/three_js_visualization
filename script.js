import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.19.0/dist/cannon-es.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/jsm/controls/OrbitControls.js';

// --- Basic Setup ---
let scene, camera, renderer, controls;
let physicsWorld;
const objectsToUpdate = []; // Store { mesh, body } pairs

function init() {
    // Physics World
    physicsWorld = new CANNON.World({
        gravity: new CANNON.Vec3(0, -9.82, 0), // Earth gravity
    });
    physicsWorld.broadphase = new CANNON.SAPBroadphase(physicsWorld);
    physicsWorld.allowSleep = true;

    // Three.js Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeeeeee);

    // Camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 5, 15); // Adjusted camera position

    // Renderer
    const canvas = document.getElementById('c');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true; // Enable shadows

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 7.5);
    directionalLight.castShadow = true;
    // Configure shadow properties if needed
    directionalLight.shadow.mapSize.width = 1024;
    directionalLight.shadow.mapSize.height = 1024;
    scene.add(directionalLight);


    // --- Ground ---
    createGround();

    // --- Create 3D Objects from DOM ---
    createObjectsFromDOM();

    // --- Event Listeners ---
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('click', onClick); // Use click for simplicity

    // --- Start Animation ---
    animate();
}

function createGround() {
    // Three.js Ground Mesh
    const groundGeometry = new THREE.PlaneGeometry(100, 100);
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, side: THREE.DoubleSide });
    const groundMesh = new THREE.Mesh(groundGeometry, groundMaterial);
    groundMesh.rotation.x = -Math.PI / 2; // Rotate to be horizontal
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);

    // Cannon.js Ground Body
    const groundShape = new CANNON.Plane();
    const groundBody = new CANNON.Body({ mass: 0 }); // mass = 0 makes it static
    groundBody.addShape(groundShape);
    groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2); // Match mesh rotation
    physicsWorld.addBody(groundBody);
}

function createObjectsFromDOM() {
    const destructibleElements = document.querySelectorAll('.destructible');
    const spacing = 4; // Space between created blocks
    let currentX = -(destructibleElements.length - 1) * spacing / 2;

    destructibleElements.forEach((element, index) => {
        // --- Simplified Positioning & Sizing ---
        // Getting exact size/pos from DOM is tricky. We'll use fixed sizes for this example.
        const width = 3;  // Example width in 3D units
        const height = 2; // Example height
        const depth = 0.5;// Example depth

        // Starting position in the 3D world (simple grid layout)
        const posX = currentX + index * spacing;
        const posY = 5 + Math.random() * 2; // Start slightly above ground, randomized
        const posZ = 0;

        // --- Three.js Mesh ---
        const geometry = new THREE.BoxGeometry(width, height, depth);
        const material = new THREE.MeshStandardMaterial({
            color: Math.random() * 0xffffff, // Random color
            // wireframe: true // Enable wireframe if texture loading fails
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(posX, posY, posZ);
        mesh.castShadow = true;
        mesh.userData.elementId = element.id; // Link back to original element if needed
        scene.add(mesh);

        // --- Cannon.js Body ---
        const shape = new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2));
        const body = new CANNON.Body({
            mass: width * height * depth, // Mass proportional to volume
            position: new CANNON.Vec3(posX, posY, posZ),
            shape: shape,
        });
        physicsWorld.addBody(body);

        // --- Link Mesh and Body ---
        objectsToUpdate.push({ mesh, body });

        // --- Hide Original HTML Element ---
        element.style.display = 'none'; // Or visibility: hidden

        // --- Optional: Texture with html2canvas (More Advanced) ---
        /*
        html2canvas(element).then(canvas => {
            const texture = new THREE.CanvasTexture(canvas);
            mesh.material.map = texture;
            mesh.material.color.set(0xffffff); // Reset color if using texture
            mesh.material.needsUpdate = true;
        }).catch(e => console.error("html2canvas failed:", e));
        */
    });
}

// --- Interaction ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function onClick(event) {
    // Calculate mouse position in normalized device coordinates (-1 to +1)
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    // Update the picking ray with the camera and mouse position
    raycaster.setFromCamera(mouse, camera);

    // Calculate objects intersecting the picking ray
    const meshes = objectsToUpdate.map(o => o.mesh);
    const intersects = raycaster.intersectObjects(meshes);

    if (intersects.length > 0) {
        const intersectedMesh = intersects[0].object;
        const hitPoint = intersects[0].point; // Where the ray hit in world space

        // Find the corresponding physics body
        const obj = objectsToUpdate.find(o => o.mesh === intersectedMesh);
        if (obj && obj.body) {
            // Apply explosion effect
            applyExplosion(hitPoint, 50); // Apply force at the hit point
            console.log(`Applying explosion near ${obj.mesh.userData.elementId || 'object'}`);

            // TODO: Add particle effects or other visuals here
        }
    }
}

function applyExplosion(position, strength) {
    const explosionRadius = 5; // How far the explosion reaches
    const explosionStrength = strength;

    physicsWorld.bodies.forEach(body => {
        if (body.mass <= 0) return; // Don't affect static bodies

        const bodyPos = body.position;
        const distVec = new CANNON.Vec3();
        bodyPos.vsub(position, distVec); // Vector from explosion center to body center
        const distance = distVec.length();

        if (distance < explosionRadius) {
            const forceMagnitude = explosionStrength * (1 - distance / explosionRadius);
            if (forceMagnitude < 0) return; // Avoid pulling things in

            distVec.normalize();
            const force = distVec.scale(forceMagnitude);

            // Apply impulse at the body's center of mass for simplicity
            body.applyImpulse(force, body.position);

            // Optional: Apply impulse at the point closest to the explosion
            // const worldPoint = new CANNON.Vec3();
            // position.vadd(distVec.scale(body.shapes[0].boundingSphereRadius), worldPoint); // Approximate point
            // body.applyImpulse(force, worldPoint);

            // Wake up the body if it was sleeping
            body.wakeUp();
        }
    });
    // Simple visual cue - flash the screen (remove later)
    // document.body.style.backgroundColor = 'white';
    // setTimeout(() => { document.body.style.backgroundColor = ''; }, 50);
}

// --- Burn Effect (Placeholder) ---
function startBurning(mesh, body) {
    console.log("Starting burn effect (placeholder)");
    mesh.material.color.set(0xff0000); // Turn red

    // Example: Remove after 3 seconds
    setTimeout(() => {
        if (scene.getObjectById(mesh.id)) { // Check if still exists
            scene.remove(mesh);
            physicsWorld.removeBody(body);
            // Remove from objectsToUpdate array
            const index = objectsToUpdate.findIndex(o => o.mesh === mesh);
            if (index > -1) {
                objectsToUpdate.splice(index, 1);
            }
            console.log("Object burned away");
        }
    }, 3000);
}


// --- Animation Loop ---
const clock = new THREE.Clock();
let oldElapsedTime = 0;

function animate() {
    requestAnimationFrame(animate);

    const elapsedTime = clock.getElapsedTime();
    const deltaTime = elapsedTime - oldElapsedTime;
    oldElapsedTime = elapsedTime;

    // Update physics world
    // Use fixed time step for stability
    physicsWorld.step(1 / 60, deltaTime, 3);

    // Update Three.js meshes from physics bodies
    for (const obj of objectsToUpdate) {
        obj.mesh.position.copy(obj.body.position);
        obj.mesh.quaternion.copy(obj.body.quaternion);
    }

    // Update controls
    controls.update();

    // Render scene
    renderer.render(scene, camera);
}

// --- Window Resize ---
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Start ---
init();