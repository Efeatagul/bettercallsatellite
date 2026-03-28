import cv2  # type: ignore
import numpy as np  # type: ignore

def nothing(x):
    pass

def calibrate_hsv(image_path):
    # Görüntüyü oku
    img = cv2.imread(image_path)
    if img is None:
        print("Hata: Görüntü okunamadı.")
        return
    
    # Ekrana sığması için yeniden boyutlandır (opsiyonel)
    h, w = img.shape[:2]
    max_dim = 800
    if max(h, w) > max_dim:
        scale = max_dim / max(h, w)
        img = cv2.resize(img, (int(w * scale), int(h * scale)))

    blurred = cv2.GaussianBlur(img, (5, 5), 0)
    hsv = cv2.cvtColor(blurred, cv2.COLOR_BGR2HSV)
    
    # Trackbar penceresi
    cv2.namedWindow('Kalibrasyon', cv2.WINDOW_NORMAL)
    cv2.resizeWindow('Kalibrasyon', 600, 300)
    
    cv2.createTrackbar('H (Min)', 'Kalibrasyon', 0, 179, nothing)
    cv2.createTrackbar('S (Min)', 'Kalibrasyon', 0, 255, nothing)
    cv2.createTrackbar('V (Min)', 'Kalibrasyon', 0, 255, nothing)
    cv2.createTrackbar('H (Max)', 'Kalibrasyon', 179, 179, nothing)
    cv2.createTrackbar('S (Max)', 'Kalibrasyon', 255, 255, nothing)
    cv2.createTrackbar('V (Max)', 'Kalibrasyon', 255, 255, nothing)

    print("--- HSV KALİBRASYON ARACI ---")
    print("Canlı değerleri ayarlayın. Çıkmak için 'q' tuşuna basın.")
    
    while True:
        h_min = cv2.getTrackbarPos('H (Min)', 'Kalibrasyon')
        s_min = cv2.getTrackbarPos('S (Min)', 'Kalibrasyon')
        v_min = cv2.getTrackbarPos('V (Min)', 'Kalibrasyon')
        
        h_max = cv2.getTrackbarPos('H (Max)', 'Kalibrasyon')
        s_max = cv2.getTrackbarPos('S (Max)', 'Kalibrasyon')
        v_max = cv2.getTrackbarPos('V (Max)', 'Kalibrasyon')
        
        lower = np.array([h_min, s_min, v_min])
        upper = np.array([h_max, s_max, v_max])
        
        # Anlık maske ve sonuç
        mask = cv2.inRange(hsv, lower, upper)
        result = cv2.bitwise_and(img, img, mask=mask)
        
        cv2.imshow('Orijinal', img)
        cv2.imshow('Maske', mask)
        cv2.imshow('Sonuc', result)
        
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break
            
    cv2.destroyAllWindows()
    
    print("\n--- EN İYİ DEĞERLER ---")
    print(f"lower_val = np.array([{h_min}, {s_min}, {v_min}])")
    print(f"upper_val = np.array([{h_max}, {s_max}, {v_max}])")

if __name__ == "__main__":
    print("1. Kendi test görüntünüzü 'calibrate_hsv(\"goruntu.jpg\")' olarak aşağıdan çağırabilirsiniz.")
    # calibrate_hsv("test_image.jpg")
